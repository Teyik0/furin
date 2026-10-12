import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { version } from "../package.json";

const decoder = new TextDecoder();
const appRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(appRoot, "src/index.ts");

describe("create-furin CLI", () => {
  it("reports the scaffolder version rather than the generated project's core catalog", () => {
    const result = Bun.spawnSync([process.execPath, entrypoint, "--version"], {
      cwd: appRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString().trim()).toBe(version);
  });

  it("formats parseArgs failures through the CLI error handler", () => {
    const result = Bun.spawnSync(["bun", entrypoint, "--unknown-flag"], {
      cwd: appRoot,
      stderr: "pipe",
      stdout: "pipe",
    });

    const output = decoder.decode(result.stdout) + decoder.decode(result.stderr);
    expect(result.exitCode).toBe(1);
    expect(output).toContain('Unknown option "--unknown-flag"');
  });
});
