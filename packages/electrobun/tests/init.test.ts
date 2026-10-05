import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initDesktop, loadDesktopConfig } from "../src/project";

test("init adds desktop scripts while preserving existing scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-desktop-"));
  try {
    await writeFile(
      join(root, "package.json"),
      '{"name":"relay","version":"1.2.3","scripts":{"dev":"bun --hot src/server.ts"}}'
    );
    await initDesktop(root);
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.dev).toBe("bun --hot src/server.ts");
    expect(pkg.scripts["dev:desktop"]).toBe("furin-electrobun dev");
    expect(await readFile(join(root, "furin.desktop.config.ts"), "utf8")).toContain(
      "defineDesktopConfig"
    );
    const before = await readFile(join(root, "package.json"), "utf8");
    await expect(initDesktop(root)).rejects.toThrow("already exists");
    expect(await readFile(join(root, "package.json"), "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init refuses an existing desktop script before writing config", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-desktop-"));
  try {
    await writeFile(
      join(root, "package.json"),
      '{"name":"relay","scripts":{"dev:desktop":"custom"}}'
    );
    await expect(initDesktop(root)).rejects.toThrow("dev:desktop");
    expect(await Bun.file(join(root, "furin.desktop.config.ts")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop app version comes from the consuming package when omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-version-"));
  try {
    await writeFile(join(root, "package.json"), '{"name":"relay","version":"1.2.3"}');
    await writeFile(
      join(root, "furin.desktop.config.ts"),
      `export default {
      app: { name: "Relay", identifier: "local.furin.relay" },
      window: { width: 960, height: 720 }
    };`
    );
    expect((await loadDesktopConfig(root)).app.version).toBe("1.2.3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.skipIf(process.getuid?.() === 0)(
  "init leaves a read-only manifest untouched and publishes no config",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "furin-readonly-"));
    const manifest = join(root, "package.json");
    const original = '{"name":"relay","version":"1.2.3","scripts":{"dev":"existing"}}\n';
    try {
      await writeFile(manifest, original);
      await chmod(manifest, 0o444);
      await expect(initDesktop(root)).rejects.toThrow();
      expect(await readFile(manifest, "utf8")).toBe(original);
      expect(await readdir(root)).toEqual(["package.json"]);
    } finally {
      await chmod(manifest, 0o644);
      await rm(root, { recursive: true, force: true });
    }
  }
);

test("init preserves manifest permissions and removes transaction staging files", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-init-atomic-"));
  const manifest = join(root, "package.json");
  try {
    await writeFile(manifest, '{"name":"relay","version":"1.2.3"}');
    await chmod(manifest, 0o640);
    await initDesktop(root);
    // biome-ignore lint/suspicious/noBitwiseOperators: File-type bits are not part of permission preservation.
    expect((await stat(manifest)).mode & 0o777).toBe(0o640);
    expect((await readdir(root)).sort()).toEqual(["furin.desktop.config.ts", "package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
