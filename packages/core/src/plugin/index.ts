import { dirname, isAbsolute, resolve } from "node:path";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import {
  nextDevtoolsBuildId,
  publishDevtoolsClientBuild,
} from "../server/devtools/build-observer.ts";
import { detectLoaderFromPath } from "../server/lang-detect.ts";
import { transformForClient } from "./transform-client.ts";

const ELYSIA_FILTER = /^elysia$/;
const BUN_BUILTIN_FILTER = /^bun:/;
const ANY_FILTER = /.*/;
const SCRIPT_FILE_FILTER = /\.(tsx?|jsx?)$/;
const DELETED_CLIENT_FINGERPRINT = "deleted";

interface ObservedBuild {
  changedModules: Set<string>;
  cycleId: string;
  detectedAt: number;
  rebuiltModules: Set<string>;
  startedAt: number;
}

function observeClientFingerprint(
  path: string,
  fingerprint: string,
  detectedAt: number,
  fingerprints: Map<string, string>,
  build: ObservedBuild | undefined
): void {
  const previous = fingerprints.get(path);
  fingerprints.set(path, fingerprint);
  if (previous === fingerprint) {
    build?.changedModules.delete(path);
  } else if (previous !== undefined && build) {
    build.changedModules.add(path);
    build.detectedAt = Math.min(build.detectedAt, detectedAt);
  }
}

function collectTopologyPaths(path: string, source: string, topologyPaths: Set<string>): void {
  const normalizedPath = path.replaceAll("\\", "/");
  if (!(normalizedPath.includes("/.furin/") && normalizedPath.endsWith("/_hydrate.tsx"))) {
    return;
  }
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  for (const imported of transpiler.scanImports(source)) {
    if (isAbsolute(imported.path) || imported.path.startsWith(".")) {
      topologyPaths.add(resolve(dirname(path), imported.path));
    }
  }
}

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
    let activeBuild: ObservedBuild | undefined;
    let completedInitialBuild = false;
    const sourceFingerprints = new Map<string, string>();

    build.onStart(() => {
      activeBuild = {
        changedModules: new Set(),
        cycleId: nextDevtoolsBuildId(),
        detectedAt: Number.POSITIVE_INFINITY,
        rebuiltModules: new Set(),
        startedAt: Date.now(),
      };
    });
    build.onEnd((result) => {
      const observed = activeBuild;
      activeBuild = undefined;
      if (!observed) {
        return;
      }
      if (completedInitialBuild) {
        publishDevtoolsClientBuild({
          changedModules: [...observed.changedModules],
          cycleId: observed.cycleId,
          detectedAt: Number.isFinite(observed.detectedAt)
            ? observed.detectedAt
            : observed.startedAt,
          durationMs: Math.max(0, Date.now() - observed.startedAt),
          rebuiltModules: [...observed.rebuiltModules],
          startedAt: observed.startedAt,
          status: result.success ? "fulfilled" : "rejected",
        });
      }
      completedInitialBuild = true;
    });

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

      const previousFingerprint = sourceFingerprints.get(args.path);
      activeBuild?.rebuiltModules.add(args.path);
      if (previousFingerprint !== undefined) {
        activeBuild?.changedModules.add(args.path);
      }
      const sourceFile = Bun.file(args.path);
      let source: string;
      try {
        source = await sourceFile.text();
      } catch (error) {
        if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") {
          observeClientFingerprint(
            args.path,
            DELETED_CLIENT_FINGERPRINT,
            Date.now(),
            sourceFingerprints,
            activeBuild
          );
        }
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
      observeClientFingerprint(
        args.path,
        Bun.hash(source).toString(16),
        sourceFile.lastModified,
        sourceFingerprints,
        activeBuild
      );

      collectTopologyPaths(args.path, source, topologyPaths);
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
