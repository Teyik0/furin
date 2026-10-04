import { expect, test } from "bun:test";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { TargetBuildManifest } from "../../src/build/types.ts";
import { createTmpApp } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("Worker manifest paths resolve after relocating an application", async () => {
  const app = createTmpApp("cli-app-ssr");
  const relocated = createTmpApp("cli-app-ssr");
  try {
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const manifest: { targets: { cloudflare: TargetBuildManifest } } = await Bun.file(
      join(app.path, ".furin/build/manifest.json")
    ).json();
    const target = manifest.targets.cloudflare;
    cpSync(join(app.path, ".furin"), join(relocated.path, ".furin"), { recursive: true });
    for (const path of [target.targetDir, target.clientDir, target.serverEntry, target.serverPath]) {
      expect(path).not.toBeNull();
      expect(isAbsolute(path as string)).toBe(false);
      expect(path as string).not.toContain("\\");
      expect(existsSync(join(relocated.path, path as string))).toBe(true);
    }
    const config = await Bun.file(join(relocated.path, target.targetDir, "wrangler.jsonc")).json();
    expect(join(relocated.path, target.targetDir, config.main as string)).toBe(
      join(relocated.path, target.serverPath as string)
    );
    expect(join(relocated.path, target.targetDir, config.assets.directory as string)).toBe(
      join(relocated.path, target.clientDir as string)
    );
    expect(target.templatePath).toBeNull();
    expect(existsSync(join(app.path, ".furin/build/analysis"))).toBe(false);
  } finally {
    app.cleanup();
    relocated.cleanup();
  }
}, 60_000);

test("Worker analysis includes client and server graphs outside published assets", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    const build = await runCli(["build", "--target", "cloudflare", "--analyze"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const buildRoot = join(app.path, ".furin/build");
    for (const name of ["cloudflare-client.json", "cloudflare-server.json"]) {
      const metafile: NonNullable<Bun.BuildOutput["metafile"]> = await Bun.file(
        join(buildRoot, "analysis", name)
      ).json();
      expect(Object.keys(metafile.inputs).length).toBeGreaterThan(0);
      expect(Object.keys(metafile.outputs).length).toBeGreaterThan(0);
      expect(Object.values(metafile.outputs).some((output) => output.bytes > 0)).toBe(true);
      if (name === "cloudflare-server.json") {
        expect(Object.keys(metafile.outputs).some((path) => path.endsWith("worker.js"))).toBe(true);
      }
    }
    const assets = readdirSync(join(buildRoot, "cloudflare/assets"), { recursive: true });
    expect(assets.some((path) => String(path).includes("analysis") || String(path).endsWith(".json"))).toBe(false);
  } finally {
    app.cleanup();
  }
}, 60_000);
