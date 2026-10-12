import { expect, expectTypeOf, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@teyik0/furin/config";
import { loadCliConfig } from "../../core/src/cli/config";
import { defineDesktopConfig } from "../src/config";
import { loadDesktopConfig, loadFurinProject } from "../src/project";

test("one Furin configuration preserves typed desktop settings for both CLIs", async () => {
  const desktop = defineDesktopConfig({
    app: { name: "Unified", identifier: "local.furin.unified" },
    window: { width: 900, height: 700 },
    hostEntry: "src/host.ts",
  });
  const config = defineConfig({ rootDir: "app", serverEntry: "server.ts", desktop });
  expectTypeOf(config.desktop?.app.name).toEqualTypeOf<string | undefined>();
  const root = await mkdtemp(join(tmpdir(), "furin-unified-config-"));
  try {
    await writeFile(join(root, "package.json"), '{"version":"1.2.3"}');
    await writeFile(join(root, "furin.config.ts"), `export default ${JSON.stringify(config)};`);
    expect((await loadDesktopConfig(root)).app).toEqual({
      name: "Unified",
      identifier: "local.furin.unified",
      version: "1.2.3",
    });
    expect((await loadCliConfig(root)).desktop).toEqual(desktop);
    expect(await loadFurinProject(root)).toEqual({
      root: join(root, "app"),
      serverEntry: join(root, "app/server.ts"),
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the former standalone desktop configuration is not a supported input", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-old-config-"));
  try {
    await writeFile(join(root, "package.json"), '{"version":"1.2.3"}');
    await writeFile(
      join(root, "furin.desktop.config.ts"),
      `export default {
      app: { name: "Old", identifier: "local.furin.old" },
      window: { width: 900, height: 700 }
    };`
    );
    await expect(loadDesktopConfig(root)).rejects.toThrow("furin.config.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
