import { $ } from "bun";

$.cwd(import.meta.dir);

await $`rm -rf dist`;
await $`tsc --project tsconfig.dts.json`;

// Each entrypoint is built in its own Bun.build() call.
// Bun bug: when entrypoints share imports (elyra → router, elyra → build),
// Bun folds some outputs into others or omits them entirely. Building each
// entrypoint separately produces correct, self-contained bundles.
const shared = {
  outdir: `${import.meta.dir}/dist`,
  root: `${import.meta.dir}/src`,
  target: "bun" as const,
  format: "esm" as const,
  external: ["elysia", "react", "react-dom", "@elysiajs/static"],
  minify: false,
  sourcemap: false,
};

await Promise.all([
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/elyra.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/build.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/router.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/adapter/bun-plugin.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/link.tsx`] }),
]);
