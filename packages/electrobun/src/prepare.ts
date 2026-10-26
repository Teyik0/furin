import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix, relative, resolve, win32 } from "node:path";
import { type DesktopConfig, validateDesktopConfig } from "./config";
import { copyExternalPackages } from "./external";

// Shipped sources the generated host runs, also when this module is bundled into dist/.
const RESERVED_COPY_PATHS = [
  "furin",
  "bun/furin-host.json",
  "bun/native-open.js",
  "bun/native-restart.js",
  "bun/index.js",
];

const SOURCES = resolve(import.meta.dir, "../src");

export interface DesktopPreparation {
  mode: "dev" | "build";
  root: string;
  serverEntry: string;
}

export function renderRuntime(nativeEntry: string | undefined): string {
  return `import * as sdk from "./.hutch/devkit/api/sdks/main/index.ts";
import { runStandardDesktopHost } from ${JSON.stringify(join(SOURCES, "standard-host.ts"))};

await runStandardDesktopHost(sdk${nativeEntry ? `, undefined, () => import(${JSON.stringify(nativeEntry)})` : ""});
`;
}

export async function prepareDesktop(
  cwd: string,
  config: DesktopConfig & { app: DesktopConfig["app"] & { version: string } },
  options: DesktopPreparation
): Promise<string> {
  validateDesktopConfig(config);
  const generated = join(cwd, ".furin/electrobun");
  await mkdir(generated, { recursive: true });
  if (options.mode === "build") {
    const target = join(generated, "furin");
    await rm(target, { recursive: true, force: true });
    await cp(join(options.root, ".furin/build/bun"), target, {
      recursive: true,
      verbatimSymlinks: true,
    });
    if (!(await Bun.file(join(target, "app.js")).exists())) {
      throw new Error("Missing inert app.js; build with furin build --target bun --output app.");
    }
    await copyExternalPackages(options.root, target, config.external ?? []);
  }
  await writeFile(
    join(generated, "runtime.ts"),
    await Bun.file(join(SOURCES, "runtime.ts")).text()
  );
  await writeFile(
    join(generated, "desktop-bridge.ts"),
    await Bun.file(join(SOURCES, "desktop-bridge.ts")).text()
  );
  await writeFile(
    join(generated, "registry.ts"),
    await Bun.file(join(SOURCES, "registry.ts")).text()
  );
  await writeFile(
    join(generated, "storage.ts"),
    await Bun.file(join(SOURCES, "storage.ts")).text()
  );
  if (options.mode === "dev") {
    await writeFile(
      join(generated, "dev-server.ts"),
      await Bun.file(join(SOURCES, "dev-server.ts")).text()
    );
    await writeFile(
      join(generated, "dev.json"),
      JSON.stringify({ config, root: options.root, serverEntry: options.serverEntry })
    );
  }
  await writeFile(
    join(generated, "main.ts"),
    renderRuntime(
      config.build?.bun?.entrypoint
        ? `./${relative(generated, resolve(options.root, config.build.bun.entrypoint)).split(win32.sep).join(posix.sep)}`
        : undefined
    )
  );
  const helper = await Bun.build({
    entrypoints: [join(SOURCES, "native-open.ts")],
    target: "bun",
  });
  if (!(helper.success && helper.outputs[0])) {
    throw new AggregateError(helper.logs, "Native helper build failed.");
  }
  await writeFile(join(generated, "native-open.js"), await helper.outputs[0].text());
  const restart = await Bun.build({
    entrypoints: [join(SOURCES, "native-restart.ts")],
    target: "bun",
  });
  if (!(restart.success && restart.outputs[0])) {
    throw new AggregateError(restart.logs, "Native restart helper build failed.");
  }
  await writeFile(join(generated, "native-restart.js"), await restart.outputs[0].text());
  await writeFile(join(generated, "host.json"), JSON.stringify(config));
  await writeFile(join(generated, "control"), "");
  await writeFile(join(generated, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(
    join(generated, "hutch.config.ts"),
    'export default { electrobun: { version: "2.0.2" } };\n'
  );
  const platform = { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native" };
  const copy = Object.fromEntries(
    Object.entries(config.build?.copy ?? {}).map(([source, destination]) => {
      const target = posix.normalize(destination.replaceAll("\\", "/"));
      const reserved = target.toLowerCase();
      if (
        target === "." ||
        target === ".." ||
        target.startsWith("../") ||
        posix.isAbsolute(target) ||
        win32.isAbsolute(target) ||
        reserved === "bun" ||
        RESERVED_COPY_PATHS.some((path) => reserved === path || reserved.startsWith(`${path}/`))
      ) {
        throw new Error("SDK copy destinations must stay outside the reserved Furin artifact.");
      }
      return [resolve(options.root, source), target];
    })
  );
  const mac = config.build?.mac;
  const win = config.build?.win;
  const linux = config.build?.linux;
  const sdkConfig = {
    ...config,
    app: {
      ...config.app,
      urlSchemes: config.app?.urlSchemes,
      // The SDK packages macOS document types; mimeType is Furin's Linux registration input.
      fileAssociations: config.app?.fileAssociations?.map(({ mimeType: _, ...association }) => ({
        ...association,
        ...(association.icon ? { icon: resolve(options.root, association.icon) } : {}),
      })),
    },
    build: {
      ...config.build,
      views:
        config.build?.views &&
        Object.fromEntries(
          Object.entries(config.build.views).map(([name, view]) => [
            name,
            { ...view, entrypoint: resolve(options.root, view.entrypoint) },
          ])
        ),
      mainProcess: "bun",
      bun: {
        ...config.build?.bun,
        alias:
          config.build?.bun?.alias &&
          Object.fromEntries(
            Object.entries(config.build.bun.alias).map(([name, target]) => [
              name,
              target.startsWith(".") ? resolve(options.root, target) : target,
            ])
          ),
        entrypoint: "main.ts",
        external: config.build?.bun?.external,
      },
      copy: {
        ...(options.mode === "build" ? { furin: "furin" } : {}),
        "host.json": "bun/furin-host.json",
        "native-open.js": "bun/native-open.js",
        "native-restart.js": "bun/native-restart.js",
        ...copy,
      },
      mac: {
        ...platform,
        ...mac,
        ...(mac?.icons ? { icons: resolve(options.root, mac.icons) } : {}),
      },
      win: { ...platform, ...win, ...(win?.icon ? { icon: resolve(options.root, win.icon) } : {}) },
      linux: {
        ...platform,
        ...linux,
        ...(linux?.icon ? { icon: resolve(options.root, linux.icon) } : {}),
      },
    },
    runtime: { ...config.runtime, exitOnLastWindowClosed: false },
    scripts:
      config.scripts &&
      Object.fromEntries(
        Object.entries(config.scripts).map(([name, path]) => [name, resolve(options.root, path)])
      ),
    release: config.release,
  };
  // Furin-only policy never reaches the SDK config.
  const {
    dataDir: _dataDir,
    external: _external,
    protocols: _protocols,
    ...nativeConfig
  } = sdkConfig;
  await writeFile(
    join(generated, "electrobun.config.ts"),
    `export default ${JSON.stringify(nativeConfig, null, 2)};\n`
  );
  return generated;
}
