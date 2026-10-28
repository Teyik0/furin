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
      "native-restart.js": "bun/native-restart.js",
    });
    const hutch = await import(join(generated, "hutch.config.ts"));
    expect(hutch.default.electrobun.version).toBe("2.0.5");
    const main = await readFile(join(generated, "main.ts"), "utf8");
    expect(main).toContain("runStandardDesktopHost");
    expect(main).toContain('from "./.hutch/devkit/api/sdks/main/index.ts"');
    expect(main).not.toContain('from "electrobun/main"');
    expect(main).not.toContain("import app from");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native customization preserves packaging ownership and platform integrations", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-host-"));
  try {
    await mkdir(join(root, ".furin/build/bun"), { recursive: true });
    await writeFile(join(root, ".furin/build/bun/app.js"), "export default {};");
    const generated = await prepareDesktop(
      root,
      {
        app: {
          name: "Tofu",
          identifier: "app.tofu.dev",
          version: "0.2.1",
          urlSchemes: ["tofu-dev"],
          fileAssociations: [
            { ext: ["torrent"], name: "Torrent", mimeType: "application/x-bittorrent" },
          ],
        },
        build: {
          mainProcess: "bun",
          bun: { entrypoint: "src/desktop.ts" },
          mac: { icons: "assets/tofu.iconset", codesign: false },
          copy: { "runtime/helper.js": "bun/helper.js" },
        },
        release: { baseUrl: "https://example.com/releases" },
      },
      { mode: "build", root, serverEntry: join(root, "src/server.ts") }
    );
    const { default: sdk } = await import(join(generated, "electrobun.config.ts"));
    expect(sdk.build.bun.entrypoint).toBe("main.ts");
    expect(await readFile(join(generated, "main.ts"), "utf8")).toContain(
      `() => import(${JSON.stringify("./../../src/desktop.ts")})`
    );
    expect(sdk.build.copy).toEqual({
      furin: "furin",
      "host.json": "bun/furin-host.json",
      "native-open.js": "bun/native-open.js",
      "native-restart.js": "bun/native-restart.js",
      [join(root, "runtime/helper.js")]: "bun/helper.js",
    });
    expect(sdk.app.urlSchemes).toEqual(["tofu-dev"]);
    // mimeType registers Linux handlers at runtime; the SDK config never receives it.
    expect(sdk.app.fileAssociations).toEqual([{ ext: ["torrent"], name: "Torrent" }]);
    expect(sdk.build.mac.icons).toBe(join(root, "assets/tofu.iconset"));
    expect(sdk.build.mac.defaultRenderer).toBe("native");
    expect(sdk.build.mac.bundleCEF).toBe(false);
    expect(sdk.build.mac.bundleWGPU).toBe(false);
    expect(sdk.build.mainProcess).toBe("bun");
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
      "bun/index.js",
      "bun/native-open.js",
      "bun/native-restart.js",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: Each case writes the same generated project.
      await expect(
        prepareDesktop(
          root,
          {
            app: { name: "Fixture", identifier: "local.furin.fixture", version: "1.0.0" },
            build: { copy: { asset: destination } },
          },
          { mode: "dev", root, serverEntry: join(root, "server.ts") }
        )
      ).rejects.toThrow("SDK copy destinations");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packaging preserves SDK options and explicit CEF/WGPU opt-ins", async () => {
  const root = await mkdtemp(join(tmpdir(), "furin-sdk-options-"));
  try {
    const generated = await prepareDesktop(
      root,
      {
        app: { name: "Fixture", identifier: "local.furin.options", version: "1.0.0" },
        build: {
          bun: {
            alias: { "native-helper": "./src/native-helper.ts", react: "preact/compat" },
            define: { SDK_OPTION: '"kept"' },
            minify: true,
          },
          mac: {
            bundleCEF: true,
            bundleWGPU: true,
            defaultRenderer: "cef",
            entitlements: { "com.apple.security.network.client": true },
          },
          win: { bundleCEF: true, bundleWGPU: true },
          linux: { bundleCEF: true, bundleWGPU: true },
          views: { options: { entrypoint: "views/options.ts", minify: true } },
        },
        scripts: { postBuild: "scripts/package.ts" },
        runtime: { applicationSetting: true },
        release: { generatePatch: false },
      },
      { mode: "dev", root, serverEntry: join(root, "server.ts") }
    );
    const { default: config } = await import(join(generated, "electrobun.config.ts"));
    for (const platform of ["mac", "win", "linux"]) {
      expect(config.build[platform].bundleCEF).toBe(true);
      expect(config.build[platform].bundleWGPU).toBe(true);
    }
    expect(config.build.mac.defaultRenderer).toBe("cef");
    expect(config.build.bun.define).toEqual({ SDK_OPTION: '"kept"' });
    expect(config.build.bun.minify).toBe(true);
    expect(config.build.bun.alias).toEqual({
      "native-helper": join(root, "src/native-helper.ts"),
      react: "preact/compat",
    });
    expect(config.build.bun.entrypoint).toBe("main.ts");
    expect(config.build.views.options.entrypoint).toBe(join(root, "views/options.ts"));
    expect(config.scripts.postBuild).toBe(join(root, "scripts/package.ts"));
    expect(config.runtime).toEqual({ applicationSetting: true, exitOnLastWindowClosed: false });
    expect(config.release.generatePatch).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
