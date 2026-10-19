import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const entrypoint = resolve(appRoot, "src/index.ts");

describe("create-furin CLI", () => {
  it.each(["simple", "full"])(
    "generates %s with the workspace Elysia version and install instructions",
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
        // --no-install skipped dependencies, so the next steps must include them.
        expect(Bun.stripANSI(stdout)).toContain("  cd generated-app\n  bun install\n  bun dev\n");
      } finally {
        rmSync(parentDir, { force: true, recursive: true });
      }
    },
    30_000
  );

  it("reports the Furin version from the workspace core package", async () => {
    const child = Bun.spawn(["bun", entrypoint, "--version"], {
      cwd: appRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const core: { version: string } = await Bun.file(
      resolve(appRoot, "../../packages/core/package.json")
    ).json();

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(core.version);
  });

  it("prints help that invokes the published package name", async () => {
    const child = Bun.spawn(["bun", entrypoint, "--help"], {
      cwd: appRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const scaffolder: { name: string } = await Bun.file(resolve(appRoot, "package.json")).json();

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`bunx ${scaffolder.name} <dir>`);
  });

  it("formats parseArgs failures through the CLI error handler", async () => {
    const child = Bun.spawn(["bun", entrypoint, "--unknown-flag"], {
      cwd: appRoot,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);

    const output = stdout + stderr;
    expect(exitCode).toBe(1);
    expect(output).toContain('Unknown option "--unknown-flag"');
  });
});
