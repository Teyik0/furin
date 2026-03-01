import { $ } from "bun";

$.cwd(import.meta.dir);

await $`rm -rf dist`;
await $`tsc --project tsconfig.dts.json`;

await Bun.build({
  entrypoints: [
    `${import.meta.dir}/src/elysion.ts`,
    `${import.meta.dir}/src/client.ts`,
    `${import.meta.dir}/src/build.ts`,
    `${import.meta.dir}/src/router.ts`,
    `${import.meta.dir}/src/adapter/bun-plugin.ts`,
    `${import.meta.dir}/src/link.tsx`,
  ],
  outdir: `${import.meta.dir}/dist`,
  target: "bun", // at some point will target node for compat
  format: "esm",
  external: ["elysia", "react", "react-dom", "@elysiajs/static", "@babel/*"],
  minify: false,
  sourcemap: false,
});
