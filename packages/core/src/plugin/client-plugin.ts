import { dirname, isAbsolute, resolve } from "node:path";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { flightLoaderPlugin } from "../rsc/build/flight-loader.ts";
import { detectLoaderFromPath, SCRIPT_FILE_FILTER } from "../server/lang-detect.ts";
import { isPackageModule, stripServerCode } from "./strip-server.ts";

const ELYSIA_FILTER = /^elysia$/;
const BUN_BUILTIN_FILTER = /^bun:/;
const ANY_FILTER = /.*/;

// Minimal browser stub for elysia — `t` is only used for schema definitions
// in params/query, which the client never validates at runtime.
const ELYSIA_STUB = `\
export const t = new Proxy({}, { get: () => (...args) => args[0] ?? {} });
export class NotFoundError extends Error { constructor(m) { super(m); this.name = "NotFoundError"; } }
export class ValidationError extends Error { constructor(m) { super(m); this.name = "ValidationError"; } }
export default {};
`;

/** Records the route modules imported by the dev `.furin/_hydrate.tsx` entry. */
function trackHydrationTopology(filePath: string, source: string, topologyPaths: Set<string>) {
  const normalizedPath = filePath.replaceAll("\\", "/");
  if (!(normalizedPath.includes("/.furin/") && normalizedPath.endsWith("/_hydrate.tsx"))) {
    return;
  }
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  for (const imported of transpiler.scanImports(source)) {
    if (isAbsolute(imported.path) || imported.path.startsWith(".")) {
      topologyPaths.add(resolve(dirname(filePath), imported.path.split("?")[0] as string));
    }
  }
}

/**
 * In dev, a transform failure must not throw from onLoad: Bun 1.4.3's dev
 * server can crash when a plugin's onLoad throws (oven-sh/bun#46076). A syntax
 * error is handed back untouched for Bun to report, keeping the last valid
 * module; any other failure becomes a module that rethrows it (the server
 * reports it to the overlay). Builds still fail.
 */
function stripForMode(
  filePath: string,
  source: string,
  mode: ClientStripPluginOptions["mode"]
): { contents: string; loader: Bun.Loader } {
  try {
    return stripServerCode(filePath, source);
  } catch (error) {
    if (mode === "build") {
      throw error;
    }
    const loader = detectLoaderFromPath(filePath);
    try {
      new Bun.Transpiler({ loader }).scan(source);
    } catch {
      return { contents: source, loader };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { contents: `throw new Error(${JSON.stringify(message)});`, loader: "js" };
  }
}

interface ClientStripPluginOptions {
  /**
   * `dev` keeps deleted route modules loadable while Bun's dev server still
   * holds them in its client graph. Both modes resolve Furin's client through
   * its package exports, to the `dist` build.
   */
  mode: "dev" | "build";
}

/**
 * Furin's browser-graph plugin, shared by the dev server (bunfig
 * `[serve.static] plugins`) and the production client build:
 *  1. Stubs `elysia` for the browser with a minimal proxy.
 *  2. Stubs `bun:*` builtins with an empty module (safety net — DCE removes
 *     loader imports before they reach the browser bundle in practice).
 *  3. Strips server-only code (loader, query, params) from page files before
 *     they are bundled into the client entry.
 */
export function createClientStripPlugin({ mode }: ClientStripPluginOptions): Bun.BunPlugin {
  return {
    name: "furin-strip-server",
    setup(build) {
      flightLoaderPlugin().setup(build);
      environmentGuardPlugin("client").setup(build);
      const topologyPaths = new Set<string>();
      const loadedSources = new Map<
        string,
        { contents: string; loader: Bun.Loader; isRouteModule: boolean }
      >();
      // ── browser stubs ───────────────────────────────────────────────────────
      build.onResolve({ filter: ELYSIA_FILTER }, () => ({
        namespace: "furin-stubs",
        path: "elysia-stub",
      }));

      build.onResolve({ filter: BUN_BUILTIN_FILTER }, () => ({
        namespace: "furin-stubs",
        path: "bun-builtin-stub",
      }));

      build.onLoad({ filter: ANY_FILTER, namespace: "furin-stubs" }, (args) => ({
        contents: args.path === "elysia-stub" ? ELYSIA_STUB : "",
        loader: "js",
      }));

      // ── page file stripping ─────────────────────────────────────────────────
      build.onLoad({ filter: SCRIPT_FILE_FILTER }, async (args) => {
        const filePath = args.path.split("?")[0] as string;
        if (isPackageModule(filePath)) {
          return;
        }

        let source: string;
        try {
          source = await Bun.file(filePath).text();
        } catch (error) {
          const loaded = loadedSources.get(filePath);
          // Bun can revisit its previous client graph before topology changes remove
          // a deleted route from the hydration entry. Keep that graph loadable.
          if (
            loaded?.isRouteModule &&
            error instanceof Error &&
            "code" in error &&
            error.code === "ENOENT"
          ) {
            return loaded;
          }
          throw error;
        }

        if (mode === "dev") {
          trackHydrationTopology(filePath, source, topologyPaths);
        }
        const loaded = {
          ...stripForMode(filePath, source, mode),
          isRouteModule: topologyPaths.has(filePath),
        };
        loadedSources.set(filePath, loaded);
        return loaded;
      });
    },
  };
}
