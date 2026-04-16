export type { BunPlugin } from "bun";

import { t } from "elysia";

export const BUILD_TARGETS = ["bun", "node", "vercel", "cloudflare", "static"] as const;

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

const buildTargetSchema = t.Union(BUILD_TARGETS.map((v) => t.Literal(v)));
const compileTargetSchema = t.Union([t.Literal("server"), t.Literal("embed")]);

export const configSchema = t.Object({
  rootDir: t.Optional(t.String()),
  pagesDir: t.Optional(t.String()),
  serverEntry: t.Optional(t.String()),
  targets: t.Optional(t.Array(buildTargetSchema)),
  bun: t.Optional(
    t.Object({
      compile: t.Optional(compileTargetSchema),
    })
  ),
  static: t.Optional(
    t.Object({
      basePath: t.Optional(t.String()),
      outDir: t.Optional(t.String()),
      onSSR: t.Optional(t.Union([t.Literal("error"), t.Literal("skip")])),
    })
  ),
  // plugins omitted : TypeBox can't validate Bun.BunPlugin[] (functions)
});

export type FurinConfig = (typeof configSchema)["static"] & {
  plugins?: Bun.BunPlugin[];
  static?: StaticExportConfig;
};

export function defineConfig(config: FurinConfig): FurinConfig {
  return config;
}
