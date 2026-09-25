import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("opt-in Bun server maps stay outside the deployable artifact", async () => {
  const app = createTmpApp("cli-app");
  try {
    writeFileSync(join(app.path, "furin.config.ts"), "export default { serverSourceMaps: true };\n");
    const result = await runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);

    const privateMap = join(app.path, ".furin/build/private/server-sourcemaps/bun/server.js.map");
    const publicMap = join(app.path, ".furin/build/bun/server.js.map");
    const bundle = readFileSync(join(app.path, ".furin/build/bun/server.js"), "utf8");
    expect(existsSync(privateMap)).toBe(true);
    expect(existsSync(publicMap)).toBe(false);
    expect(bundle).not.toContain("sourceMappingURL");
  } finally {
    app.cleanup();
  }
}, 30_000);

test("compiled Bun server keeps its external maps private", async () => {
  const app = createTmpApp("cli-app");
  try {
    writeFileSync(join(app.path, "furin.config.ts"), "export default { serverSourceMaps: true };\n");
    const result = await runCli(["build", "--target", "bun", "--compile", "server"], {
      cwd: app.path,
    });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);

    const target = join(app.path, ".furin/build/bun");
    const privateDir = join(app.path, ".furin/build/private/server-sourcemaps/bun");
    expect(readdirSync(target).some((name) => name.endsWith(".map"))).toBe(false);
    expect(existsSync(privateDir)).toBe(true);
    expect(readdirSync(privateDir).some((name) => name.endsWith(".map"))).toBe(true);
  } finally {
    app.cleanup();
  }
}, 30_000);

test("opt-in Vercel server maps stay outside Build Output", async () => {
  const app = createTmpApp("cli-app");
  try {
    writeFileSync(join(app.path, "furin.config.ts"), "export default { serverSourceMaps: true };\n");
    const result = await runCli(["build", "--target", "vercel"], { cwd: app.path });
    expect(result.exitCode, result.stderr + result.stdout).toBe(0);

    expect(
      existsSync(join(app.path, ".furin/build/private/server-sourcemaps/vercel/handler.js.map"))
    ).toBe(true);
    expect(existsSync(join(app.path, ".vercel/output/functions/__server.func/handler.js.map"))).toBe(
      false
    );
  } finally {
    app.cleanup();
  }
}, 30_000);

test("a build with server maps disabled removes maps from an earlier release", async () => {
  const app = createTmpApp("cli-app");
  try {
    const config = join(app.path, "furin.config.ts");
    writeFileSync(config, "export default { serverSourceMaps: true };\n");
    const first = await runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(first.exitCode, first.stderr + first.stdout).toBe(0);
    const privateMap = join(app.path, ".furin/build/private/server-sourcemaps/bun/server.js.map");
    expect(existsSync(privateMap)).toBe(true);

    writeFileSync(config, "export default { serverSourceMaps: false };\n");
    const second = await runCli(["build", "--target", "bun"], { cwd: app.path });
    expect(second.exitCode, second.stderr + second.stdout).toBe(0);
    expect(existsSync(privateMap)).toBe(false);
  } finally {
    app.cleanup();
  }
}, 30_000);
