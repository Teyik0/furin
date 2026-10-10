import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
    expect(pkg.scripts["dev:desktop"]).toBeUndefined();
    expect(pkg.scripts["build:desktop"]).toBe("furin-electrobun build");
    expect(await readFile(join(root, "furin.config.ts"), "utf8")).toContain("defineDesktopConfig");
    expect(Bun.TOML.parse(await Bun.file(join(root, "bunfig.toml")).text())).toEqual({
      preload: ["@teyik0/furin-electrobun/preload"],
    });
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
    expect(await Bun.file(join(root, "furin.config.ts")).exists()).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init preserves an existing unified config and refuses to rewrite application code", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-init-existing-"));
  const path = join(root, "furin.config.ts");
  const manifest = '{"name":"relay","version":"1.2.3"}';
  try {
    await writeFile(join(root, "package.json"), manifest);
    const original = 'export default { serverEntry: "server.ts" };';
    await writeFile(path, original);
    await expect(initDesktop(root)).rejects.toThrow("Add desktop");
    expect(await Bun.file(path).text()).toBe(original);
    expect(await Bun.file(join(root, "package.json")).text()).toBe(manifest);
    const configured = join(root, "configured");
    await mkdir(configured);
    const settings = `export default { desktop: {
      app: {name:"Existing",identifier:"local.furin.existing"},
      window: {width:900,height:700}
    }};`;
    await writeFile(join(configured, "furin.config.ts"), settings);
    await writeFile(join(configured, "package.json"), manifest);
    await initDesktop(configured);
    expect(await Bun.file(join(configured, "furin.config.ts")).text()).toBe(settings);
    expect((await Bun.file(join(configured, "package.json")).json()).scripts.dev).toBe(
      "bun --hot src/server.ts"
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop app version comes from the consuming package when omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-version-"));
  try {
    await writeFile(join(root, "package.json"), '{"name":"relay","version":"1.2.3"}');
    await writeFile(
      join(root, "furin.config.ts"),
      `export default { desktop: {
      app: { name: "Relay", identifier: "local.furin.relay" },
      window: { width: 960, height: 720 }
    } };`
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
    if (process.platform !== "win32") {
      // biome-ignore lint/suspicious/noBitwiseOperators: File-type bits are not part of permission preservation.
      expect((await stat(manifest)).mode & 0o777).toBe(0o640);
    }
    expect((await readdir(root)).sort()).toEqual([
      "bunfig.toml",
      "furin.config.ts",
      "package.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init preserves Bun plugins and refuses to rewrite an existing preload array", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-init-bunfig-"));
  const manifest = '{"name":"relay","version":"1.2.3"}';
  const settings =
    '[serve.static]\nplugins = ["tailwind", "furin/strip-plugin"]\nenv = "FURIN_PUBLIC_*"\n';
  try {
    await writeFile(join(root, "package.json"), manifest);
    await writeFile(join(root, "bunfig.toml"), `preload = ["./custom.ts"]\n${settings}`);
    const original = await Bun.file(join(root, "bunfig.toml")).text();
    await expect(initDesktop(root)).rejects.toThrow("existing preload");
    expect(await Bun.file(join(root, "bunfig.toml")).text()).toBe(original);
    expect(await Bun.file(join(root, "package.json")).text()).toBe(manifest);
    expect(await Bun.file(join(root, "furin.config.ts")).exists()).toBe(false);
    await writeFile(join(root, "bunfig.toml"), settings);
    await initDesktop(root);
    const actual = await Bun.file(join(root, "bunfig.toml")).text();
    expect(actual).toBe(`preload = ["@teyik0/furin-electrobun/preload"]\n\n${settings}`);
    expect(Bun.TOML.parse(actual)).toEqual({
      preload: ["@teyik0/furin-electrobun/preload"],
      serve: { static: { plugins: ["tailwind", "furin/strip-plugin"], env: "FURIN_PUBLIC_*" } },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
