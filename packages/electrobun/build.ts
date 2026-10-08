import { chmod, rm } from "node:fs/promises";
import { join } from "node:path";

const root = import.meta.dir;
await rm(join(root, "dist"), { recursive: true, force: true });
const declarations = Bun.spawn(
  [process.execPath, "x", "--no-install", "tsc", "-p", "tsconfig.dts.json"],
  { cwd: root, stdout: "inherit", stderr: "inherit" }
);
if ((await declarations.exited) !== 0) {
  throw new Error("Desktop declarations failed.");
}
const result = await Bun.build({
  entrypoints: [
    join(root, "src/config.ts"),
    join(root, "src/server.ts"),
    join(root, "src/host.ts"),
  ],
  external: ["elysia", "elysia/*"],
  target: "bun",
  format: "esm",
  outdir: join(root, "dist"),
});
if (!result.success) {
  throw new AggregateError(result.logs, "Desktop package build failed.");
}
await chmod(join(root, "src/cli.ts"), 0o755);
