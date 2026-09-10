import { randomUUID } from "node:crypto";
import { isAbsolute, relative } from "node:path";
import {
  DEV_DIAGNOSTIC_PROTOCOL_VERSION,
  type DevDiagnostic,
  type DevDiagnosticEvent,
  type DevDiagnosticPhase,
  type DevSourceLocation,
} from "../../shared/dev-diagnostics.ts";
import { type FurinInstance, instanceSlot } from "../instance.ts";
import { devGraph } from "./graph.ts";
import { symbolicateStack } from "./symbolicate.ts";

interface DiagnosticContext {
  entryPath: string;
  importChain: readonly string[] | undefined;
  phase: DevDiagnosticPhase;
  route: string;
}

export interface ClientErrorReport {
  cause: string | undefined;
  message: string;
  phase: "client-render" | "hydrate";
  route: string;
  stack: string | undefined;
}

const STACK_POSITION_RE = /(?:^|\s)\(?((?:file:\/\/|furin-dev-page:)?\S+):(\d+):(\d+)\)?$/;
const DEV_PAGE_PREFIX_RE = /^furin-dev-page:/;
const QUERY_RE = /\?.*$/;
const EVENT_LIMIT = 100;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function causeOf(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.cause === undefined) {
    return;
  }
  return messageOf(error.cause);
}

function displayPath(path: string): string {
  const projected = relative(process.cwd(), path).replaceAll("\\", "/");
  return projected.startsWith("../") ? path : projected;
}

function stackLocation(
  stack: string | undefined,
  entryPath: string
): DevSourceLocation | undefined {
  if (!stack) {
    return;
  }
  const locations: DevSourceLocation[] = [];
  for (const line of stack.split("\n")) {
    const match = STACK_POSITION_RE.exec(line.trim());
    if (!(match?.[1] && match[2] && match[3])) {
      continue;
    }
    const file = match[1].replace(DEV_PAGE_PREFIX_RE, "").replace(QUERY_RE, "");
    locations.push({
      column: Number.parseInt(match[3], 10),
      file: file.startsWith("file://") ? file.slice("file://".length) : file,
      line: Number.parseInt(match[2], 10),
    });
  }
  return locations.find((location) => location.file === entryPath) ?? locations[0];
}

function explicitLocation(error: unknown, entryPath: string): DevSourceLocation | undefined {
  if (typeof error !== "object" || error === null) {
    return;
  }
  const candidate = error as {
    furinPosition?: { column?: unknown; file?: unknown; line?: unknown };
    position?: { column?: unknown; file?: unknown; line?: unknown };
  };
  const position = candidate.furinPosition ?? candidate.position;
  if (!position || typeof position.column !== "number" || typeof position.line !== "number") {
    return;
  }
  return {
    column: position.column,
    file:
      typeof position.file === "string" &&
      (isAbsolute(position.file) || position.file.startsWith("file://"))
        ? position.file
        : entryPath,
    line: position.line,
  };
}

export function createDevDiagnostic(error: unknown, context: DiagnosticContext): DevDiagnostic {
  const stack = error instanceof Error ? error.stack : undefined;
  const sourceLocation =
    explicitLocation(error, context.entryPath) ?? stackLocation(stack, context.entryPath);
  const location = sourceLocation
    ? { ...sourceLocation, file: displayPath(sourceLocation.file) }
    : undefined;
  const importChain =
    context.importChain ??
    devGraph(undefined).importChain(context.entryPath, sourceLocation?.file ?? context.entryPath);
  return {
    cause: causeOf(error),
    frames: [],
    importChain: importChain.map(displayPath),
    location,
    message: messageOf(error),
    phase: context.phase,
    route: context.route,
    stack,
  };
}

export class DevDiagnosticStore {
  readonly #events: DevDiagnosticEvent[] = [];
  readonly #listeners = new Set<(event: DevDiagnosticEvent) => void>();
  readonly #serverId = randomUUID();
  #activeError: Extract<DevDiagnosticEvent, { type: "error" }> | undefined;
  #eventId = 0;
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  markReady(): DevDiagnosticEvent | undefined {
    if (!this.#activeError) {
      return;
    }
    this.#activeError = undefined;
    this.#revision += 1;
    return this.#publish({ type: "ready" });
  }

  publish(diagnostic: DevDiagnostic): Extract<DevDiagnosticEvent, { type: "error" }> {
    const event = this.#publish({ diagnostic, type: "error" }) as Extract<
      DevDiagnosticEvent,
      { type: "error" }
    >;
    this.#activeError = event;
    return event;
  }

  subscribe(
    after: number,
    serverId: string | undefined,
    listener: (event: DevDiagnosticEvent) => void
  ): { replay: readonly DevDiagnosticEvent[]; unsubscribe: () => void } {
    this.#listeners.add(listener);
    let replay: readonly DevDiagnosticEvent[] = [];
    if (serverId === this.#serverId) {
      replay = this.#events.filter((event) => event.id > after);
    } else if (this.#activeError) {
      replay = [this.#activeError];
    }
    return {
      replay,
      unsubscribe: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #publish(
    event: { diagnostic: DevDiagnostic; type: "error" } | { type: "ready" }
  ): DevDiagnosticEvent {
    this.#eventId += 1;
    const complete = {
      ...event,
      id: this.#eventId,
      revision: this.#revision,
      serverId: this.#serverId,
      version: DEV_DIAGNOSTIC_PROTOCOL_VERSION,
    } as DevDiagnosticEvent;
    this.#events.push(complete);
    if (this.#events.length > EVENT_LIMIT) {
      this.#events.shift();
    }
    for (const listener of this.#listeners) {
      listener(complete);
    }
    return complete;
  }
}

const diagnosticStoreSlot = instanceSlot(() => new DevDiagnosticStore());

export function devDiagnosticStore(instance?: FurinInstance): DevDiagnosticStore {
  return diagnosticStoreSlot(instance);
}

export function publishDevDiagnostic(
  error: unknown,
  context: Omit<DiagnosticContext, "importChain"> & { importChain?: readonly string[] }
): Extract<DevDiagnosticEvent, { type: "error" }> {
  const diagnostic = createDevDiagnostic(error, {
    ...context,
    importChain: context.importChain,
  });
  return devDiagnosticStore().publish(diagnostic);
}

export async function publishClientDiagnostic(
  store: DevDiagnosticStore,
  report: ClientErrorReport,
  origin: string
): Promise<Extract<DevDiagnosticEvent, { type: "error" }>> {
  const symbolicated = await symbolicateStack({ origin, stack: report.stack });
  const location = symbolicated.location
    ? { ...symbolicated.location, file: displayPath(symbolicated.location.file) }
    : undefined;
  const importChain = devGraph(undefined)
    .importChain(process.cwd(), symbolicated.location?.file ?? process.cwd())
    .map(displayPath);
  let displayedImportChain: readonly string[] = [];
  if (importChain.length > 1) {
    displayedImportChain = importChain.slice(1);
  } else if (location) {
    displayedImportChain = [location.file];
  }
  return store.publish({
    cause: report.cause,
    frames: symbolicated.frames,
    importChain: displayedImportChain,
    location,
    message: report.message,
    phase: report.phase,
    route: report.route,
    stack: report.stack,
  });
}
