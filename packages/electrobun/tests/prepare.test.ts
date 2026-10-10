import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareDesktop } from "../src/prepare";

test("desktop build keeps the whole Furin artifact outside the SDK main bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-prepare-"));
  try {
    const artifact = join(root, ".furin/build/bun");
    await mkdir(join(artifact, "client/nested"), { recursive: true });
    await mkdir(join(artifact, "public"), { recursive: true });
    await writeFile(join(artifact, "app.js"), "export default {};");
    await writeFile(join(artifact, "client/nested/chunk.js"), "client");
    await writeFile(join(artifact, "public/logo.svg"), "public");
    const generated = await prepareDesktop(
      root,
      {
        app: { name: "Relay", identifier: "local.furin.relay", version: "1.2.3" },
        window: { width: 960, height: 720 },
      },
      { mode: "build", root, serverEntry: join(root, "src/server.ts") }
    );
    expect(await readFile(join(generated, "furin/client/nested/chunk.js"), "utf8")).toBe("client");
    expect(await readFile(join(generated, "furin/public/logo.svg"), "utf8")).toBe("public");
    const sdkConfig = await import(join(generated, "electrobun.config.ts"));
    expect(sdkConfig.default.build.copy).toEqual({
      furin: "furin",
      "host.json": "bun/furin-host.json",
      "native-open.js": "bun/native-open.js",
    });
    const main = await readFile(join(generated, "main.ts"), "utf8");
    expect(main).toContain("runStandardDesktopHost");
    expect(main).toContain('from "electrobun/main"');
    expect(main).not.toContain("import app from");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a custom native host preserves packaging ownership and platform integrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-host-"));
  try {
    await mkdir(join(root, ".furin/build/bun"), { recursive: true });
    await writeFile(join(root, ".furin/build/bun/app.js"), "export default {};");
    const generated = await prepareDesktop(
      root,
      {
        app: { name: "Tofu", identifier: "app.tofu.dev", version: "0.2.1" },
        window: { width: 1400, height: 940 },
        hostEntry: "src/desktop.ts",
        sdk: {
          app: { urlSchemes: ["tofu-dev"], fileAssociations: [] },
          build: {
            mac: { icons: "assets/tofu.iconset", codesign: false },
            copy: { "runtime/helper.js": "bun/helper.js" },
          },
          release: { baseUrl: "https://example.com/releases" },
        },
      },
      { mode: "build", root, serverEntry: join(root, "src/server.ts") }
    );
    const { default: sdk } = await import(join(generated, "electrobun.config.ts"));
    expect(sdk.build.bun.entrypoint).toBe(join(root, "src/desktop.ts"));
    expect(sdk.build.copy).toEqual({
      furin: "furin",
      "host.json": "bun/furin-host.json",
      "native-open.js": "bun/native-open.js",
      [join(root, "runtime/helper.js")]: "bun/helper.js",
    });
    expect(sdk.app.urlSchemes).toEqual(["tofu-dev"]);
    expect(sdk.build.mac.icons).toBe(join(root, "assets/tofu.iconset"));
    expect(sdk.build.mac.defaultRenderer).toBe("native");
    expect(sdk.release.baseUrl).toBe("https://example.com/releases");
    expect(await Bun.file(join(generated, "furin/app.js")).exists()).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK copy destinations cannot alias or escape the reserved artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-copy-alias-"));
  try {
    for (const destination of [
      "./furin",
      "other/../furin",
      "furin\\app.js",
      "FURIN/app.js",
      ".",
      "../furin",
      "/furin",
      "C:\\furin",
      "bun",
      "bun/furin-host.json",
      "bun/furin-host.json/child",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each case writes the same generated project.
      await expect(
        prepareDesktop(
          root,
          {
            app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
            window: { width: 800, height: 600 },
            sdk: { build: { copy: { asset: destination } } },
          },
          { mode: "dev", root, serverEntry: join(root, "server.ts") }
        )
      ).rejects.toThrow("SDK copy destinations");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
