import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

$.cwd(import.meta.dir);

await $`rm -rf dist bin`;
await $`rm -f tsconfig.dts.tsbuildinfo`;
await $`bunx tsc --project tsconfig.dts.json`;

// Each entrypoint is built in its own Bun.build() call.
// Bun bug: when entrypoints share imports (furinjs → router, furinjs → build),
// Bun folds some outputs into others or omits them entirely. Building each
// entrypoint separately produces correct, self-contained bundles.
const shared = {
  external: [
    "elysia",
    "react",
    "react-dom",
    "react-server-dom-webpack",
    "@elysiajs/static",
    "yuku-parser",
  ],
  format: "esm" as const,
  minify: false,
  outdir: `${import.meta.dir}/dist`,
  root: `${import.meta.dir}/src`,
  sourcemap: false,
  target: "bun" as const,
};

await Promise.all([
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/cli/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/furin.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/routes.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/rsc.tsx`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/rsc-client.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server-only.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client-only.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/build/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/config.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/sync/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/sync/postgres/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/sync/postgres/migrate.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/sync/redis/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/sync/sqlite/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/plugin/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client/link.tsx`] }),
  // Modules imported directly by the generated compile-entry (entry-template.ts).
  // Must exist as standalone files so the dist/ fallback path works.
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/internal.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/server/runtime-env.ts`] }),
]);

await Bun.build({
  ...shared,
  conditions: ["react-server"],
  entrypoints: [`${import.meta.dir}/src/rsc/server-codec.ts`],
  naming: "server-codec.js",
  outdir: `${import.meta.dir}/dist/rsc`,
});

// Copy ambient declaration so it is available for the ./env export.
await $`cp src/env.d.ts dist/env.d.ts`;

// Ensure target directories exist before copying runtime source files.
// dist/build is created by Bun.build above, but dist/server/render is not —
// without this, clean builds where tsc is
// skipped would fail.
mkdirSync(`${import.meta.dir}/dist/build`, { recursive: true });
mkdirSync(`${import.meta.dir}/dist/server/render`, { recursive: true });
mkdirSync(`${import.meta.dir}/dist/server/sync/postgres`, { recursive: true });

// Copy template source files that the adapter reads at runtime.
await $`cp src/build/compile-entry.ts dist/build/compile-entry.ts`;
await $`cp src/build/entry-template.ts dist/build/entry-template.ts`;
await $`cp src/server/render/index.ts dist/server/render/index.ts`;
await $`cp src/server/render/shell.ts dist/server/render/shell.ts`;
await $`cp src/server/sync/postgres/migration.sql dist/server/sync/postgres/migration.sql`;

// Prepend shebang to CLI dist file so the OS runs it with Bun (not as a shell script).
// Guard against duplication: if the shebang is already present (e.g. build run twice),
// skip the write so we don't corrupt the file with a double shebang.
for (const executablePath of [
  `${import.meta.dir}/dist/cli/index.js`,
  `${import.meta.dir}/dist/server/sync/postgres/migrate.js`,
]) {
  const content = readFileSync(executablePath, "utf8");
  if (!content.startsWith("#!")) {
    writeFileSync(executablePath, `#!/usr/bin/env bun\n${content}`);
  }
  chmodSync(executablePath, 0o755);
}
