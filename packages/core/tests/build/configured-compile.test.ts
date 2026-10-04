import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../support/app-fixtures";
import { runCli } from "../support/process";

test("Cloudflare builds do not inherit the configured Bun compile mode", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "furin.config.ts", `export default { bun: { compile: "embed" } };`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    expect(await Bun.file(join(app.path, ".furin/build/cloudflare/worker.js")).exists()).toBe(true);
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Cloudflare still rejects an explicitly requested compile mode", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "furin.config.ts", `export default { bun: { compile: "server" } };`);
    const build = await runCli(["build", "--target", "cloudflare", "--compile", "embed"], {
      cwd: app.path,
    });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("Cloudflare Workers cannot compile a Bun executable");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Bun inherits configured compilation and an explicit mode overrides it", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "furin.config.ts", `export default { bun: { compile: "embed" } };`);
    const configured = await runCli(["build"], { cwd: app.path });
    expect(configured.exitCode, configured.stderr).toBe(0);
    const embedded = await Bun.file(join(app.path, ".furin/build/manifest.json")).json();
    expect(embedded.targets.bun.serverPath).not.toEndWith(".js");
    expect(embedded.targets.bun.clientDir).toBeNull();
    const explicit = await runCli(["build", "--compile", "server"], { cwd: app.path });
    expect(explicit.exitCode, explicit.stderr).toBe(0);
    const onDisk = await Bun.file(join(app.path, ".furin/build/manifest.json")).json();
    expect(onDisk.targets.bun.serverPath).not.toEndWith(".js");
    expect(onDisk.targets.bun.clientDir).not.toBeNull();
  } finally {
    app.cleanup();
  }
}, 60_000);

test("all preserves Bun configured compilation and the existing target set", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(
      app.path,
      "furin.config.ts",
      `export default { bun: { compile: "embed" }, static: { onSSR: "skip" } };`
    );
    const build = await runCli(["build", "--target", "all"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const manifest = await Bun.file(join(app.path, ".furin/build/manifest.json")).json();
    expect(Object.keys(manifest.targets).sort()).toEqual(["bun", "static", "vercel"]);
    expect(manifest.targets.bun.serverPath).not.toEndWith(".js");
    expect(manifest.targets.bun.clientDir).toBeNull();
    expect(
      await Bun.file(join(app.path, manifest.targets.vercel.serverPath, "index.js")).exists()
    ).toBe(true);
  } finally {
    app.cleanup();
  }
}, 60_000);
