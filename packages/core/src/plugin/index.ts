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

interface ObservedBuild {
  changedModules: Set<string>;
  cycleId: string;
  detectedAt: number;
  rebuiltModules: Set<string>;
  startedAt: number;
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

      const sourceFile = Bun.file(args.path);
      const source = await sourceFile.text();
      const fingerprint = Bun.hash(source).toString(16);
      const previousFingerprint = sourceFingerprints.get(args.path);
      sourceFingerprints.set(args.path, fingerprint);
      activeBuild?.rebuiltModules.add(args.path);
      if (previousFingerprint !== undefined && previousFingerprint !== fingerprint) {
        activeBuild?.changedModules.add(args.path);
        if (activeBuild) {
          activeBuild.detectedAt = Math.min(activeBuild.detectedAt, sourceFile.lastModified);
        }
      }

      const result = transformForClient(source, args.path);
      // Output is TS/TSX (yuku parses directly, no pre-transpile). Bun's
      // bundler picks the loader from the file extension and applies the
      // project tsconfig — including the JSX automatic runtime.
      return {
        contents: result.code,
        loader: detectLoaderFromPath(args.path),
      };
    });
  },
};

export default plugin;
