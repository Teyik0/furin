import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { clientModuleKey } from "../plugin/transform-client-module.ts";
import type { ResolvedRoute } from "../server/router/types.ts";

const CLIENT_MODULE_KEY_RE = /(["'`])(__FURIN_CLIENT_MODULE_[a-z0-9]+__)\1/g;

/** Chunk URLs to `<link rel="modulepreload">`, derived from the client build graph. */
export interface ClientPreloadManifest {
  /** `clientModule()` key → the module's chunk and its transitive static imports. */
  modules: Record<string, string[]>;
  /** Route pattern → page, layout and boundary chunks plus their transitive static imports. */
  routes: Record<string, string[]>;
}

/** Client modules a route's hydration loads (mirrors the generated hydrate entry). */
function routeModulePaths(route: ResolvedRoute): string[] {
  const layouts = (route.routeChain ?? [])
    .slice(1)
    .filter((entry) => entry.layout && entry.sourcePath)
    .map((entry) => entry.sourcePath as string);
  const boundaries = (route.segmentBoundaries ?? []).flatMap((segment) =>
    [segment.errorPath, segment.notFoundPath].filter((path) => path !== undefined)
  );
  return [route.path, ...layouts, ...boundaries];
}

function realPath(path: string): string | null {
  return existsSync(path) ? realpathSync(path) : null;
}

/**
 * Builds the preload manifest from Bun's metafile and swaps every
 * `clientModule()` key left in the emitted JS for its chunk URLs.
 *
 * Chunks the entry already loads statically are excluded. Rewriting a chunk
 * after hashing is safe: its hash covers the hashes of every chunk it imports,
 * so the URLs it now embeds can only change when its own name changes.
 */
export function writeClientPreloadManifest(
  metafile: Bun.BuildMetafile,
  outputPaths: string[],
  entryChunkPath: string,
  routes: ResolvedRoute[],
  publicPrefix: string
): ClientPreloadManifest {
  const outputs = new Map(
    Object.entries(metafile.outputs).map(([path, output]) => [basename(path), output])
  );
  const closure = (file: string, seen: Set<string>): Set<string> => {
    if (!seen.has(file)) {
      seen.add(file);
      for (const imported of outputs.get(file)?.imports ?? []) {
        if (imported.kind === "import-statement") {
          closure(basename(imported.path), seen);
        }
      }
    }
    return seen;
  };
  const entryFiles = closure(basename(entryChunkPath), new Set());
  const hrefsOf = (file: string) =>
    [...closure(file, new Set())]
      .filter((chunk) => !entryFiles.has(chunk))
      .map((chunk) => `${publicPrefix}${chunk}`);

  const chunkByModule = new Map<string, string>();
  for (const [file, output] of outputs) {
    const modulePath = output.entryPoint ? realPath(resolve(output.entryPoint)) : null;
    if (modulePath !== null) {
      chunkByModule.set(modulePath, file);
    }
  }

  const routeManifest: ClientPreloadManifest["routes"] = {};
  for (const route of routes) {
    const files = routeModulePaths(route)
      .map((path) => chunkByModule.get(realPath(path) ?? path))
      .filter((file) => file !== undefined);
    routeManifest[route.pattern] = [...new Set(files.flatMap(hrefsOf))];
  }

  const moduleHrefs = new Map(
    [...chunkByModule].map(([modulePath, file]) => [clientModuleKey(modulePath), file])
  );
  const modules: ClientPreloadManifest["modules"] = {};
  for (const path of outputPaths.filter((output) => output.endsWith(".js"))) {
    const code = readFileSync(path, "utf8");
    const rewritten = code.replace(CLIENT_MODULE_KEY_RE, (_match, _quote, key: string) => {
      const file = moduleHrefs.get(key);
      modules[key] = file === undefined ? [] : hrefsOf(file);
      return JSON.stringify(modules[key]);
    });
    if (rewritten !== code) {
      writeFileSync(path, rewritten);
    }
  }

  return { modules, routes: routeManifest };
}
