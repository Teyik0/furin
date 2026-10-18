import type { BunPlugin } from "bun";
import { t } from "elysia";
import type { Static } from "typebox";
import type { FurinAdapter } from "./adapter/types.ts";

export type {
  AdapterApp,
  AdapterBuildOutput,
  AdapterCapabilities,
  AdapterPrerender,
  AdapterRoute,
  AdapterServerBundle,
  AdapterTargetManifest,
  FurinAdapter,
} from "./adapter/types.ts";

export const BUILD_TARGETS = ["bun", "vercel", "static", "package"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

/**
 * Configuration for the `static` build target.
 * Produces a fully pre-rendered directory deployable to any static host
 * (GitHub Pages, Netlify, Surge.sh, …).
 */
export interface StaticExportConfig {
  /**
   * Sub-path prefix for GitHub Pages sub-path deployments.
   * e.g. "/furin" when the site is served at `https://user.github.io/furin/`.
   * Must start with "/" and have no trailing slash.
   * Default: "" (site served at root).
   */
  basePath?: string;
  /**
   * Behaviour when SSR or ISR routes are encountered during a static build.
   * - "error" (default): throw at build time with the list of incompatible routes.
   * - "skip": emit a warning and omit those routes from the output.
   */
  onSSR?: "error" | "skip";
  /**
   * Output directory for the static export.
   * Default: "dist".
   */
  outDir?: string;
}

const compileTargetSchema = t.Union([t.Literal("server"), t.Literal("embed")]);

export const configSchema = t.Object({
  /**
   * Multi-instance builds: one entry per mounted furin app. Overrides
   * `pagesDir` and server-entry auto-detection. `prefix` must match the
   * `furin({ prefix })` the app is mounted with (`""`/absent = root).
   */
  apps: t.Optional(
    t.Array(
      t.Object({
        pagesDir: t.String(),
        prefix: t.Optional(t.String()),
      })
    )
  ),
  bun: t.Optional(
    t.Object({
      compile: t.Optional(compileTargetSchema),
    })
  ),
  /**
   * Initialize the browser HTTP log drain in the hydration entry. Off by
   * default — enabling it adds `evlog/http` drain setup and points browser
   * events at `/_furin/ingest`. Server-side logging is unaffected (configured
   * via the `furin({ logger })` plugin option).
   */
  clientLogging: t.Optional(t.Boolean()),
  /**
   * Package barrels Bun should parse on demand in production client bundles.
   * Packages declaring `sideEffects: false` are optimized automatically.
   */
  optimizeImports: t.Optional(t.Array(t.String())),
  pagesDir: t.Optional(t.String()),
  /**
   * Module preloading. `routeChunks` (default true) makes `<HeadContent />`
   * emit `<link rel="modulepreload">` for the current route's chunks.
   */
  preload: t.Optional(t.Object({ routeChunks: t.Optional(t.Boolean()) })),
  /**
   * Enable Bun's native Rust React Compiler for production client bundles.
   * Enabled by default.
   */
  reactCompiler: t.Optional(t.Boolean()),
  rootDir: t.Optional(t.String()),
  serverEntry: t.Optional(t.String()),
  /** Emit private server source maps for error-tool uploads. Off by default. */
  serverSourceMaps: t.Optional(t.Boolean()),
  static: t.Optional(
    t.Object({
      basePath: t.Optional(t.String()),
      onSSR: t.Optional(t.Union([t.Literal("error"), t.Literal("skip")])),
      outDir: t.Optional(t.String()),
    })
  ),
  // plugins and targets omitted: TypeBox can't validate functions
});

export type FurinPlugin = BunPlugin & { buildOnly?: boolean };

/** A built-in target name or a deployment adapter object. */
export type FurinTarget = BuildTarget | FurinAdapter;

export type FurinConfig = Static<typeof configSchema> & {
  plugins?: FurinPlugin[];
  static?: StaticExportConfig;
  /**
   * Targets `furin build` builds when `--target` is omitted (default: bun).
   * `--target <name>` picks the entry of that name, else the built-in one —
   * so `vercel({ regions })` here configures `furin build --target vercel`.
   */
  targets?: FurinTarget[];
};

export function defineConfig(config: FurinConfig): FurinConfig {
  return config;
}
