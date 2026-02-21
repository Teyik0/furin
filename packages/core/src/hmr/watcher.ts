import { realpathSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { TSchema } from "elysia";
import type { TypeCheck } from "elysia/type-system";
import type { ServerWebSocket } from "elysia/ws/bun";
import { transformForReactRefresh } from "./transform";

// Lightweight Bun.Transpiler singleton used only for scanImports().
// Separate from transform.ts's bunTranspiler to avoid coupling.
const scanTranspiler = new Bun.Transpiler({ loader: "tsx" });

type HmrClient = ServerWebSocket<{
  id?: string | undefined;
  validator?: TypeCheck<TSchema> | undefined;
}>;

// Safely access import.meta.hot — may be undefined outside bun --hot.
const hot = typeof import.meta.hot !== "undefined" ? import.meta.hot : null;
const hmrData: Record<string, unknown> = hot?.data ?? {};

// WebSocket clients — persisted across hot reloads via import.meta.hot.data.
// This is a true server singleton (live connections), not HMR infrastructure.
const clients: Set<HmrClient> = (hmrData.clients ??= new Set<HmrClient>()) as Set<HmrClient>;

// Per-file version counters — persisted across hot reloads.
// Incremented by the file watcher so SSR always uses the latest module version
// without creating a new cache entry on every request (which would leak memory).
const moduleVersions: Map<string, number> = (hmrData.moduleVersions ??= new Map<
  string,
  number
>()) as Map<string, number>;

// Cache for pre-built non-page modules (e.g. src/client.ts that import npm packages).
// Bun.build() can fail with EISDIR when resolving packages from Bun's .bun/ cache;
// caching avoids repeated failed builds and expensive re-bundling per request.
const builtModuleCache: Map<string, string> = (hmrData.builtModuleCache ??= new Map<
  string,
  string
>()) as Map<string, string>;

// Reverse dependency graph: dep absolute path → Set of files that import it.
// Built lazily in getTransformedModule() via scanImports(). Persisted across hot reloads
// so the graph survives server restarts without requiring a full re-scan.
const depGraph: Map<string, Set<string>> = (hmrData.depGraph ??= new Map<
  string,
  Set<string>
>()) as Map<string, Set<string>>;

/** Normalize a path to its real filesystem path (resolves symlinks). */
function realpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

/** Resolve a relative import path to a normalized absolute path, or null if not resolvable. */
function resolveImportPath(importPath: string, fromFile: string): string | null {
  if (!importPath.startsWith(".")) {
    return null;
  }
  try {
    // Bun.resolveSync already returns a real path on macOS (resolves /var → /private/var).
    return Bun.resolveSync(importPath, dirname(fromFile));
  } catch {
    return null;
  }
}

/** Scan a source file's imports and register them in the reverse dep graph. */
function updateDepGraph(fullPath: string, source: string): void {
  const normalizedFullPath = realpath(fullPath);

  for (const dependents of depGraph.values()) {
    dependents.delete(normalizedFullPath);
  }

  const imports = scanTranspiler.scanImports(source);
  for (const { path: importPath } of imports) {
    const resolved = resolveImportPath(importPath, normalizedFullPath);
    if (!resolved) {
      continue;
    }
    const normalizedResolved = realpath(resolved);
    if (!depGraph.has(normalizedResolved)) {
      depGraph.set(normalizedResolved, new Set());
    }
    depGraph.get(normalizedResolved)?.add(normalizedFullPath);
  }
}

export function getModuleVersion(absolutePath: string): number {
  return moduleVersions.get(absolutePath) ?? 0;
}

export function invalidateModuleCache(absolutePath: string): void {
  moduleVersions.set(absolutePath, (moduleVersions.get(absolutePath) ?? 0) + 1);
  // Cascade: bump version for all transitively-dependent modules so SSR re-fetches them.
  for (const dep of getAffectedModules(absolutePath)) {
    moduleVersions.set(dep, (moduleVersions.get(dep) ?? 0) + 1);
  }
}

/** BFS over the reverse dep graph. Returns all files that (transitively) depend on changedFile. */
export function getAffectedModules(changedFile: string): string[] {
  const normalized = realpath(changedFile);
  const visited = new Set<string>();
  const queue = [normalized];
  visited.add(normalized);
  while (queue.length > 0) {
    const current = queue.shift();
    for (const dep of depGraph.get(current as string) ?? []) {
      if (!visited.has(dep)) {
        visited.add(dep);
        queue.push(dep);
      }
    }
  }
  visited.delete(normalized);
  return [...visited];
}

export function getHmrClients(): Set<HmrClient> {
  return clients;
}

export function broadcastMessage(message: string): void {
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  }
}

export async function getTransformedModule(
  fullPath: string,
  srcDir: string,
  pagesDir: string
): Promise<string> {
  const file = Bun.file(fullPath);
  if (!(await file.exists())) {
    throw new Error(`File not found: ${fullPath}`);
  }

  const relativePath = relative(srcDir, fullPath).replace(/\\/g, "/");
  const moduleId = `/_modules/src/${relativePath}`;

  // Non-page files (e.g. client utilities) may import bare module specifiers
  // (like @elysiajs/eden) that the browser cannot resolve without a bundler.
  // Bundle them with Bun.build() so all dependencies are inlined as ESM.
  //
  // React and react-dom are marked external: they live in Bun's .bun/ local
  // cache which is not seekable by Bun.build() at runtime. The HMR hydrate
  // entry already exposes window.React = React, so page-side utilities that
  // use React can rely on that global instead of bundling a second copy.
  //
  // Results are cached per-file: Bun.build() can fail with EISDIR when
  // resolving packages from Bun's .bun/ cache (a directory is read as a file).
  // Caching avoids repeated failures and expensive re-bundling per request.
  if (relative(pagesDir, fullPath).startsWith("..")) {
    const cached = builtModuleCache.get(fullPath);
    if (cached) {
      return cached;
    }

    const result = await Bun.build({
      entrypoints: [fullPath],
      format: "esm",
      target: "browser",
      // Use the full browser conditions order to avoid Bun resolving packages
      // from its .bun/ internal cache (where some entries are directories,
      // not files, causing EISDIR errors).
      conditions: ["browser", "import", "module", "default"],
      splitting: false,
      minify: false,
      external: [
        "react",
        "react-dom",
        "react-dom/client",
        "react/jsx-runtime",
        "react/jsx-dev-runtime",
      ],
    });

    if (!result.success) {
      const messages = result.logs.map((l) => l.message).join("\n");
      throw new Error(`Bun.build() failed for ${fullPath}:\n${messages}`);
    }

    const output = result.outputs[0];
    if (!output) {
      throw new Error(`Bun.build() produced no output for ${fullPath}`);
    }

    const code = await output.text();
    builtModuleCache.set(fullPath, code);
    return code;
  }

  const source = await file.text();
  updateDepGraph(fullPath, source);
  return transformForReactRefresh(source, fullPath, moduleId, srcDir, pagesDir);
}

// HMR lifecycle — persist clients, module versions, and built module cache across hot reloads.
export function persistHmrState(data: Record<string, unknown>): void {
  data.clients = clients;
  data.moduleVersions = moduleVersions;
  data.builtModuleCache = builtModuleCache;
  data.depGraph = depGraph;
}

hot?.dispose(persistHmrState);
