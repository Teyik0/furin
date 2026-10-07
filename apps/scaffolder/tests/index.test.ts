import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const decoder = new TextDecoder();
const appRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(appRoot, "src/index.ts");

describe("create-furin CLI", () => {
  it.each(["simple", "full"])(
    "generates %s with the workspace Elysia version",
    async (template) => {
      const parentDir = mkdtempSync(resolve(tmpdir(), "create-furin-cli-"));
      const targetDir = resolve(parentDir, "generated-app");
      try {
        const child = Bun.spawn(
          [
            process.execPath,
            entrypoint,
            "generated-app",
            "--template",
            template,
            "--yes",
            "--no-install",
          ],
          { cwd: parentDir, stderr: "pipe", stdout: "pipe", timeout: 20_000 }
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        expect(exitCode, stdout + stderr).toBe(0);
        const generated: { dependencies: { elysia: string } } = await Bun.file(
          resolve(targetDir, "package.json")
        ).json();
        const workspace: { catalog: { elysia: string } } = await Bun.file(
          resolve(appRoot, "../../package.json")
        ).json();
        expect(generated.dependencies.elysia).toBe(workspace.catalog.elysia);
      } finally {
        rmSync(parentDir, { force: true, recursive: true });
      }
    },
    30_000
  );

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
