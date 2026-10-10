import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, posix, resolve, win32 } from "node:path";
import type { DesktopConfig } from "./config";
import { copyExternalPackages } from "./external";

export interface DesktopPreparation {
  mode: "dev" | "build";
  root: string;
  serverEntry: string;
}

export function renderRuntime(): string {
  return `import * as sdk from "electrobun/main";
import { runStandardDesktopHost } from ${JSON.stringify(join(import.meta.dir, "standard-host.ts"))};

await runStandardDesktopHost(sdk);
`;
}

export async function prepareDesktop(
  cwd: string,
  config: DesktopConfig & { app: DesktopConfig["app"] & { version: string } },
  options: DesktopPreparation
): Promise<string> {
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
    await Bun.file(join(import.meta.dir, "runtime.ts")).text()
  );
  await writeFile(
    join(generated, "registry.ts"),
    await Bun.file(join(import.meta.dir, "registry.ts")).text()
  );
  if (options.mode === "dev") {
    await writeFile(
      join(generated, "dev-server.ts"),
      await Bun.file(join(import.meta.dir, "dev-server.ts")).text()
    );
    await writeFile(
      join(generated, "dev.json"),
      JSON.stringify({ config, root: options.root, serverEntry: options.serverEntry })
    );
  }
  await writeFile(join(generated, "main.ts"), renderRuntime());
  const helper = await Bun.build({
    entrypoints: [join(import.meta.dir, "native-open.ts")],
    target: "bun",
  });
  if (!(helper.success && helper.outputs[0])) {
    throw new AggregateError(helper.logs, "Native helper build failed.");
  }
  await writeFile(join(generated, "native-open.js"), await helper.outputs[0].text());
  await writeFile(join(generated, "host.json"), JSON.stringify(config));
  await writeFile(join(generated, "control"), "");
  await writeFile(join(generated, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(
    join(generated, "hutch.config.ts"),
    'export default { electrobun: { version: "2.0.2" } };\n'
  );
  const platform = { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native" };
  const additions = config.sdk;
  const copy = Object.fromEntries(
    Object.entries(additions?.build?.copy ?? {}).map(([source, destination]) => {
      const target = posix.normalize(destination.replaceAll("\\", "/"));
      const reserved = target.toLowerCase();
      if (
        target === "." ||
        target === ".." ||
        target.startsWith("../") ||
        posix.isAbsolute(target) ||
        win32.isAbsolute(target) ||
        reserved === "bun" ||
        reserved === "bun/furin-host.json" ||
        reserved.startsWith("bun/furin-host.json/") ||
        reserved === "furin" ||
        reserved.startsWith("furin/")
      ) {
        throw new Error("SDK copy destinations must stay outside the reserved Furin artifact.");
      }
      return [resolve(options.root, source), target];
    })
  );
  const mac = additions?.build?.mac;
  const win = additions?.build?.win;
  const linux = additions?.build?.linux;
  const sdkConfig = {
    app: {
      ...config.app,
      urlSchemes: additions?.app?.urlSchemes,
      fileAssociations: additions?.app?.fileAssociations?.map((association) => ({
        ...association,
        ...(association.icon ? { icon: resolve(options.root, association.icon) } : {}),
      })),
    },
    build: {
      mainProcess: "bun",
      bun: {
        entrypoint: config.hostEntry ? resolve(options.root, config.hostEntry) : "main.ts",
        external: additions?.build?.bun?.external,
      },
      copy: {
        ...(options.mode === "build" ? { furin: "furin" } : {}),
        "host.json": "bun/furin-host.json",
        "native-open.js": "bun/native-open.js",
        ...copy,
      },
      mac: {
        ...mac,
        ...platform,
        ...(mac?.icons ? { icons: resolve(options.root, mac.icons) } : {}),
      },
      win: { ...win, ...platform, ...(win?.icon ? { icon: resolve(options.root, win.icon) } : {}) },
      linux: {
        ...linux,
        ...platform,
        ...(linux?.icon ? { icon: resolve(options.root, linux.icon) } : {}),
      },
    },
    runtime: { exitOnLastWindowClosed: false },
    release: additions?.release,
  };
  await writeFile(
    join(generated, "electrobun.config.ts"),
    `export default ${JSON.stringify(sdkConfig, null, 2)};\n`
  );
  return generated;
}
