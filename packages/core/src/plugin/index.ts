import { dirname, isAbsolute, resolve } from "node:path";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { detectLoaderFromPath } from "../server/lang-detect.ts";
import { transformForClient } from "./transform-client.ts";

const ELYSIA_FILTER = /^elysia$/;
const BUN_BUILTIN_FILTER = /^bun:/;
const ANY_FILTER = /.*/;
const SCRIPT_FILE_FILTER = /\.(tsx?|jsx?)$/;

// Minimal browser stub for elysia — `t` is only used for schema definitions
// in params/query, which the client never validates at runtime.
const ELYSIA_STUB = `\
export const t = new Proxy({}, { get: () => (...args) => args[0] ?? {} });
export class NotFoundError extends Error { constructor(m) { super(m); this.name = "NotFoundError"; } }
export class ValidationError extends Error { constructor(m) { super(m); this.name = "ValidationError"; } }
export default {};
`;

/**
 * Standalone Bun bundler plugin for Furin.
 *
 * Register it in your project's bunfig.toml so that Bun's HTML bundler
 * applies it when building the client bundle:
 *
 * ```toml
 * [serve.static]
 * plugins = ["@teyik0/furin/strip-plugin"]
 * ```
 *
 * The plugin:
 *  1. Stubs `elysia` for the browser with a minimal proxy.
 *  2. Stubs `bun:*` builtins with an empty module (safety net — DCE removes
 *     loader imports before they reach the browser bundle in practice).
 *  3. Strips server-only code (loader, query, params) from page files before
 *     they are bundled into the client entry.
 */
const plugin: Bun.BunPlugin = {
  name: "furin-strip-server",
  setup(build) {
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
      if (args.path.includes("node_modules")) {
        return;
      }

      let source: string;
      try {
        source = await Bun.file(args.path).text();
      } catch (error) {
        const loaded = loadedSources.get(args.path);
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

      const normalizedPath = args.path.replaceAll("\\", "/");
      if (normalizedPath.includes("/.furin/") && normalizedPath.endsWith("/_hydrate.tsx")) {
        const transpiler = new Bun.Transpiler({ loader: "tsx" });
        for (const imported of transpiler.scanImports(source)) {
          if (isAbsolute(imported.path) || imported.path.startsWith(".")) {
            topologyPaths.add(resolve(dirname(args.path), imported.path));
          }
        }
      }
      const result = transformForClient(source, args.path);
      // Output is TS/TSX (yuku parses directly, no pre-transpile). Bun's
      // bundler picks the loader from the file extension and applies the
      // project tsconfig — including the JSX automatic runtime.
      const loaded = {
        contents: result.code,
        isRouteModule: topologyPaths.has(args.path),
        loader: detectLoaderFromPath(args.path),
      };
      loadedSources.set(args.path, loaded);
      return loaded;
    });
  },
};

export default plugin;
