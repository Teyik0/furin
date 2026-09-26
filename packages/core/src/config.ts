import type { BunPlugin } from "bun";
import { t } from "elysia";
import type { Static } from "typebox";

export const BUILD_TARGETS = ["bun", "vercel", "static", "package"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

// https://vercel.com/docs/regions#region-list
const VERCEL_REGIONS = [
  "arn1",
  "bom1",
  "cdg1",
  "cle1",
  "cpt1",
  "dub1",
  "fra1",
  "gru1",
  "hkg1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "lhr1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
  "yul1",
] as const;

export type VercelRegion = (typeof VERCEL_REGIONS)[number];

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

export interface VercelDeploymentConfig {
  /** Vercel compute regions, such as "cdg1" or "iad1". */
  regions?: VercelRegion[];
}

const buildTargetSchema = t.Union(BUILD_TARGETS.map((v) => t.Literal(v)));
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
  targets: t.Optional(t.Array(buildTargetSchema)),
  vercel: t.Optional(
    t.Object({
      regions: t.Optional(
        t.Array(t.Enum(VERCEL_REGIONS), {
          minItems: 1,
          uniqueItems: true,
        })
      ),
    })
  ),
  // plugins omitted : TypeBox can't validate Bun.BunPlugin[] (functions)
});

export type FurinPlugin = BunPlugin & { buildOnly?: boolean };

export type FurinConfig = Static<typeof configSchema> & {
  plugins?: FurinPlugin[];
  static?: StaticExportConfig;
};

export function defineConfig(config: FurinConfig): FurinConfig {
  return config;
}
