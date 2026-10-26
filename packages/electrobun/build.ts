import { chmod, cp, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
await import("./prepare-sdk");
await rm(join(root, ".furin/declarations"), { recursive: true, force: true });
await rm(join(root, "dist"), { recursive: true, force: true });
const declarations = Bun.spawn(
  [process.execPath, "x", "--no-install", "tsc", "-p", "tsconfig.dts.json"],
  { cwd: root, stdout: "inherit", stderr: "inherit" }
);
if ((await declarations.exited) !== 0) {
  throw new Error("Desktop declarations failed.");
}
await cp(join(root, ".furin/declarations/src"), join(root, "dist"), { recursive: true });
const result = await Bun.build({
  entrypoints: [
    join(root, "src/config.ts"),
    join(root, "src/server.ts"),
    join(root, "src/host.ts"),
    join(root, "src/dev.ts"),
    join(root, "src/web-dev.ts"),
    join(root, "src/preload.ts"),
  ],
  external: ["elysia", "elysia/*"],
  target: "bun",
  format: "esm",
  outdir: join(root, "dist"),
});
if (!result.success) {
  throw new AggregateError(result.logs, "Desktop package build failed.");
}
const client = await Bun.build({
  entrypoints: [join(root, "src/client.ts")],
  banner: '"use client";',
  external: ["react"],
  target: "browser",
  format: "esm",
  outdir: join(root, "dist"),
});
if (!client.success) {
  throw new AggregateError(client.logs, "Desktop client build failed.");
}
await chmod(join(root, "src/cli.ts"), 0o755);
