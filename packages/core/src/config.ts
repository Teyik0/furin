export type { BunPlugin } from "bun";

import { t } from "elysia";

export const BUILD_TARGETS = ["bun", "node", "vercel", "cloudflare"] as const;

export type BuildTarget = (typeof BUILD_TARGETS)[number];

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
  // plugins omitted : TypeBox can't validate Bun.BunPlugin[] (functions)
});

export type ElyraConfig = (typeof configSchema)["static"] & {
  plugins?: Bun.BunPlugin[];
};

export function defineConfig(config: ElyraConfig): ElyraConfig {
  return config;
}
