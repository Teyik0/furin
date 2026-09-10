import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, extname } from "node:path";
import type { FurinRouteDispatcher } from "../../define-route.ts";
import { currentInstance, type FurinInstance } from "../instance.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";

export const DEV_ERROR_PROTOCOL_VERSION = 1;

export type DevErrorPhase = "hydrate" | "import" | "loader" | "render" | "transform";

export interface DevErrorPayload {
  cause: string | null;
  column: number | null;
  file: string | null;
  importChain: string[];
  line: number | null;
  message: string;
  phase: DevErrorPhase;
  route: string;
  stack: string | null;
}

export interface DevelopmentRouteSnapshot {
  render: FurinRouteDispatcher;
  root: RootLayout;
  routes: ResolvedRoute[];
}

interface DevEventBase {
  id: number;
  revision: number;
  serverId: string;
  version: typeof DEV_ERROR_PROTOCOL_VERSION;
}

export type DevGraphEvent =
  | (DevEventBase & { error: DevErrorPayload; type: "error" })
  | (DevEventBase & { type: "ready" });

interface DevModuleCacheEntry {
  module: Promise<unknown>;
  sourceVersion: string;
}

interface DevModuleRevision {
  fingerprint: string;
  revision: number;
}

export interface DevGraphMetrics {
  events: number;
  modules: number;
  revision: number;
}

export interface DevSourcePosition {
  column: number | null;
  file: string;
  line: number | null;
}

type DevModuleImporter<Module> = (specifier: string) => Promise<Module>;

const EVENT_LIMIT = 100;

function normalizeModulePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function resolveDevSourceImports(
  source: string,
  path: string,
  loader: "js" | "jsx" | "ts" | "tsx"
) {
  const imports: string[] = [];
  const transpiler = new Bun.Transpiler({ loader });
  for (const imported of transpiler.scanImports(source)) {
    try {
      const resolved = normalizeModulePath(Bun.resolveSync(imported.path, dirname(path)));
      if (!resolved.includes("/node_modules/")) {
        imports.push(resolved);
      }
    } catch {
      // Bun's import error remains the primary diagnostic.
    }
  }
  return { imports, transpiler };
}

function transformErrorPosition(
  error: unknown,
  message: string,
  path: string
): DevSourcePosition | undefined {
  if (!(error instanceof Error) || error.message !== message) {
    return;
  }
  const { position } = error as Error & {
    position?: { column?: unknown; line?: unknown };
  };
  return {
    column: typeof position?.column === "number" ? position.column : null,
    file: path,
    line: typeof position?.line === "number" ? position.line : null,
  };
}

/**
 * Single source of truth for development runtime state.
 *
 * A graph commit swaps the complete route snapshot before publishing `ready`,
 * so requests never observe a partially rebuilt route tree. Module identities,
 * per-runtime cache state, compilation revisions, and overlay events share the
 * same lifetime.
 */
export class DevGraph<Snapshot> {
  readonly #dependencies = new Map<string, Set<string>>();
  readonly #events: DevGraphEvent[] = [];
  readonly #listeners = new Set<(event: DevGraphEvent) => void>();
  readonly #moduleCaches = new WeakMap<
    DevModuleImporter<unknown>,
    Map<string, DevModuleCacheEntry>
  >();
  readonly #state = new Map<symbol, unknown>();
  readonly #modulePaths = new Set<string>();
  readonly #moduleRevisions = new Map<string, DevModuleRevision>();
  readonly #sourceErrors = new Map<string, Map<string, DevSourcePosition>>();
  readonly #serverId = randomUUID();
  #eventSequence = 0;
  #revision = 0;
  #snapshot: Snapshot;
  #sourceGeneration = 0;

  constructor(initialSnapshot: Snapshot) {
    this.#snapshot = initialSnapshot;
  }

  get events(): DevGraphEvent[] {
    return [...this.#events];
  }

  get revision(): number {
    return this.#revision;
  }

  get metrics(): DevGraphMetrics {
    return {
      events: this.#events.length,
      modules: this.#modulePaths.size,
      revision: this.#revision,
    };
  }

  get snapshot(): Snapshot {
    return this.#snapshot;
  }

  commit(snapshot: Snapshot): void {
    this.#snapshot = snapshot;
    this.#revision += 1;
    this.#publish({ type: "ready" });
  }

  diagnoseTransformError(entryPath: string, message: string): DevSourcePosition | undefined {
    const pending = [normalizeModulePath(entryPath)];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const path = pending.shift();
      if (!path || visited.has(path)) {
        continue;
      }
      visited.add(path);
      const loader = sourceLoader(path);
      if (loader === undefined) {
        continue;
      }
      try {
        const source = readFileSync(path, "utf8");
        const { imports, transpiler } = resolveDevSourceImports(source, path, loader);
        this.recordImports(path, imports);
        try {
          transpiler.transformSync(source, loader);
        } catch (error) {
          const position = transformErrorPosition(error, message, path);
          if (position) {
            return position;
          }
        }
        pending.push(...imports);
      } catch {
        // A removed or unreadable source cannot contribute a diagnostic.
      }
    }
  }

  async importModule<Module>(
    path: string,
    sourceVersion: string,
    importModule: DevModuleImporter<Module>
  ): Promise<Module> {
    const modulePath = normalizeModulePath(path);
    this.#modulePaths.add(modulePath);
    const importer = importModule as DevModuleImporter<unknown>;
    let cache = this.#moduleCaches.get(importer);
    if (!cache) {
      cache = new Map();
      this.#moduleCaches.set(importer, cache);
    }
    const cached = cache.get(modulePath);
    if (cached?.sourceVersion === sourceVersion) {
      return cached.module as Promise<Module>;
    }

    const entry: DevModuleCacheEntry = {
      module: importModule(`${modulePath}?furin-server&t=${sourceVersion}`),
      sourceVersion,
    };
    cache.set(modulePath, entry);
    try {
      return (await entry.module) as Module;
    } catch (error) {
      if (cache.get(modulePath) === entry) {
        cache.delete(modulePath);
      }
      throw error;
    }
  }

  importChain(from: string, to: string): string[] {
    const normalizedFrom = normalizeModulePath(from);
    const normalizedTo = normalizeModulePath(to);
    if (normalizedFrom === normalizedTo) {
      return [normalizedFrom];
    }
    const pending: Array<{ chain: string[]; path: string }> = [
      { chain: [normalizedFrom], path: normalizedFrom },
    ];
    const visited = new Set([normalizedFrom]);
    while (pending.length > 0) {
      const current = pending.shift();
      if (!current) {
        break;
      }
      for (const dependency of this.#dependencies.get(current.path) ?? []) {
        const chain = [...current.chain, dependency];
        if (dependency === normalizedTo) {
          return chain;
        }
        if (!visited.has(dependency)) {
          visited.add(dependency);
          pending.push({ chain, path: dependency });
        }
      }
    }
    return [normalizedFrom];
  }

  dependsOn(from: string, to: string): boolean {
    const normalizedTo = normalizeModulePath(to);
    return this.importChain(from, normalizedTo).includes(normalizedTo);
  }

  publishError(error: DevErrorPayload): Extract<DevGraphEvent, { type: "error" }> {
    const latest = this.#events.at(-1);
    if (latest?.type === "error" && JSON.stringify(latest.error) === JSON.stringify(error)) {
      return latest;
    }
    return this.#publish({ error, type: "error" }) as Extract<DevGraphEvent, { type: "error" }>;
  }

  recordImports(importer: string, imports: string[]): void {
    this.#dependencies.set(
      normalizeModulePath(importer),
      new Set(imports.map(normalizeModulePath))
    );
  }

  recordSourceError(message: string, position: DevSourcePosition): void {
    let positions = this.#sourceErrors.get(message);
    if (!positions) {
      positions = new Map();
      this.#sourceErrors.set(message, positions);
    }
    const file = normalizeModulePath(position.file);
    positions.set(file, { ...position, file });
  }

  sourceError(message: string, entryPath: string): DevSourcePosition | undefined {
    const positions = this.#sourceErrors.get(message);
    if (!positions) {
      return;
    }
    for (const position of positions.values()) {
      if (this.dependsOn(entryPath, position.file)) {
        return position;
      }
    }
  }

  invalidateModules(): void {
    this.#sourceGeneration += 1;
  }

  sourceVersion(path: string): string {
    const modulePath = normalizeModulePath(path);
    const fingerprint = this.#sourceFingerprint(modulePath, new Set());
    const current = this.#moduleRevisions.get(modulePath);
    if (current?.fingerprint === fingerprint) {
      return String(current.revision);
    }
    const revision = (current?.revision ?? 0) + 1;
    this.#moduleRevisions.set(modulePath, { fingerprint, revision });
    return String(revision);
  }

  #sourceFingerprint(path: string, visited: Set<string>): string {
    if (visited.has(path)) {
      return path;
    }
    visited.add(path);
    let ownFingerprint: string;
    try {
      const stats = statSync(path, { bigint: true });
      ownFingerprint = `${stats.mtimeNs}:${stats.size}:${this.#sourceGeneration}`;
    } catch {
      ownFingerprint = `missing:${this.#sourceGeneration}`;
    }
    const dependencies = [...(this.#dependencies.get(path) ?? [])]
      .toSorted((left, right) => left.localeCompare(right))
      .map((dependency) => this.#sourceFingerprint(dependency, visited));
    return `${path}:${ownFingerprint}:${dependencies.join(",")}`;
  }

  state<Value>(key: symbol, initialize: () => Value): Value {
    if (this.#state.has(key)) {
      return this.#state.get(key) as Value;
    }
    const value = initialize();
    this.#state.set(key, value);
    return value;
  }

  subscribe(
    after: number,
    serverId: string | undefined,
    listener: (event: DevGraphEvent) => void
  ): { replay: DevGraphEvent[]; unsubscribe: () => void } {
    this.#listeners.add(listener);
    const cursor = serverId === this.#serverId ? after : 0;
    return {
      replay: this.#events.filter((event) => event.id > cursor),
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #publish(event: { error: DevErrorPayload; type: "error" } | { type: "ready" }): DevGraphEvent {
    this.#eventSequence += 1;
    const complete = {
      ...event,
      id: this.#eventSequence,
      revision: this.#revision,
      serverId: this.#serverId,
      version: DEV_ERROR_PROTOCOL_VERSION,
    } as DevGraphEvent;
    this.#events.push(complete);
    if (this.#events.length > EVENT_LIMIT) {
      this.#events.shift();
    }
    for (const listener of this.#listeners) {
      try {
        listener(complete);
      } catch {
        // A closing development socket must not abort an atomic graph commit.
      }
    }
    return complete;
  }
}

function sourceLoader(path: string): "js" | "jsx" | "ts" | "tsx" | undefined {
  const extension = extname(path);
  if (extension === ".js" || extension === ".jsx" || extension === ".ts" || extension === ".tsx") {
    return extension.slice(1) as "js" | "jsx" | "ts" | "tsx";
  }
}

const DEV_GRAPH_STATE = Symbol.for("@teyik0/furin/dev-graph");
const DEVELOPMENT_GRAPHS = Symbol.for("@teyik0/furin/development-graphs");

function developmentGraphMap(): Map<string, DevGraph<DevelopmentRouteSnapshot | null>> {
  const existing = Reflect.get(globalThis, DEVELOPMENT_GRAPHS);
  if (existing instanceof Map) {
    return existing as Map<string, DevGraph<DevelopmentRouteSnapshot | null>>;
  }
  const graphs = new Map<string, DevGraph<DevelopmentRouteSnapshot | null>>();
  Reflect.set(globalThis, DEVELOPMENT_GRAPHS, graphs);
  return graphs;
}

export function developmentGraphs(): DevGraph<DevelopmentRouteSnapshot | null>[] {
  return [...new Set(developmentGraphMap().values())];
}

export function devGraph(
  instance: FurinInstance | undefined
): DevGraph<DevelopmentRouteSnapshot | null> {
  const target = instance ?? currentInstance();
  const key = `${target.pagesDir}\0${target.prefix}`;
  const graphs = developmentGraphMap();
  const registered = graphs.get(key);
  if (registered) {
    target.state.set(DEV_GRAPH_STATE, registered);
    return registered;
  }
  const existing = target.state.get(DEV_GRAPH_STATE);
  if (existing !== undefined) {
    const graph = existing as DevGraph<DevelopmentRouteSnapshot | null>;
    graphs.set(key, graph);
    return graph;
  }
  const graph = new DevGraph<DevelopmentRouteSnapshot | null>(null);
  target.state.set(DEV_GRAPH_STATE, graph);
  graphs.set(key, graph);
  return graph;
}
