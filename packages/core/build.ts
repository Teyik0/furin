import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { $ } from "bun";

$.cwd(import.meta.dir);

await $`rm -rf dist bin`;
await $`bunx tsc --project tsconfig.dts.json`;

// Each entrypoint is built in its own Bun.build() call.
// Bun bug: when entrypoints share imports (furinjs → router, furinjs → build),
// Bun folds some outputs into others or omits them entirely. Building each
// entrypoint separately produces correct, self-contained bundles.
const shared = {
  outdir: `${import.meta.dir}/dist`,
  root: `${import.meta.dir}/src`,
  target: "bun" as const,
  format: "esm" as const,
  external: ["elysia", "react", "react-dom", "@elysiajs/static", "oxc-parser"],
  minify: false,
  sourcemap: false,
};

await Promise.all([
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/cli/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/furin.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/client.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/build/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/config.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/router.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/plugin/index.ts`] }),
  Bun.build({ ...shared, entrypoints: [`${import.meta.dir}/src/link.tsx`] }),
]);

// Prepend shebang to CLI dist file so the OS runs it with Bun (not as a shell script).
// Guard against duplication: if the shebang is already present (e.g. build run twice),
// skip the write so we don't corrupt the file with a double shebang.
const cliPath = `${import.meta.dir}/dist/cli/index.js`;
const content = readFileSync(cliPath, "utf8");
if (!content.startsWith("#!")) {
  writeFileSync(cliPath, `#!/usr/bin/env bun\n${content}`);
}
chmodSync(cliPath, 0o755);
