import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopConfig } from "./config";
import { copyExternalPackages } from "./external";

export interface DesktopPreparation {
  mode: "dev" | "build";
  root: string;
  serverEntry: string;
}

export function renderRuntime(
  config: DesktopConfig,
  options: DesktopPreparation,
  generated: string
): string {
  const backend =
    options.mode === "build"
      ? `const dataDir = ${config.dataDir ? JSON.stringify(config.dataDir) : "join(paths.appData, config.app.identifier)"};
const artifact = join(import.meta.dir, "../furin/app.js");
const backend = await startDesktopBackend(
  (): Promise<DesktopAppModule> => import(pathToFileURL(artifact).href),
  dataDir,
  "build"
).catch((error) => {
  console.error("[furin-electrobun] Startup failed:", error);
  quit(1);
  throw error;
});
console.log("[furin-electrobun]", config.app.identifier, backend.origin, "data:", dataDir);`
      : `const ready: { origin: string; bootstrapOrigin: string; url: string } = await Bun.file(${JSON.stringify(join(generated, "ready.json"))}).json();
const backend = { ...ready, stop: async () => {
  await Bun.write(${JSON.stringify(join(generated, "control"))}, crypto.randomUUID());
} };`;
  return `import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BrowserWindow } from "./.hutch/devkit/api/sdks/main/entries/browser-window";
import events from "./.hutch/devkit/api/sdks/main/entries/events";
import { paths, openExternal, quit } from "./.hutch/devkit/api/sdks/main/entries/utils";
import { getExternalUrl, startDesktopBackend, withShutdownDeadline, type DesktopAppModule } from "./runtime";

const config = ${JSON.stringify(config)};
${backend}
const localOrigins = [backend.origin, backend.bootstrapOrigin];
const window = new BrowserWindow({
  title: config.app.name,
  frame: config.window,
  url: backend.url,
  renderer: "native",
  sandbox: true,
  allowedProtocols: { views: false, appData: false },
  navigationRules: JSON.stringify(["^*", ...localOrigins.map((origin) => origin + "/*")]),
});
let cleaned = false;
let closing: Promise<void> | undefined;
const shutdown = (): Promise<void> => {
  closing ??= (async () => {
    let code = 0;
    try { window.webview?.setNavigationRules(["^*"]); }
    catch (error) {
      code = 1;
      console.error("[furin-electrobun] Navigation lockdown failed:", error);
    }
    try { await withShutdownDeadline(backend.stop()); }
    catch (error) {
      code = 1;
      console.error("[furin-electrobun] Shutdown failed:", error);
    }
    finally {
      cleaned = true;
      try { window.close(); }
      catch (error) {
        code = 1;
        console.error("[furin-electrobun] Window close failed:", error);
      }
      finally { quit(code); }
    }
  })();
  return closing;
};
window.on("close", () => { shutdown().catch(console.error); });
events.on("before-quit", (event: { response: { allow: boolean } }) => {
  if (!cleaned) {
    event.response = { allow: false };
    shutdown().catch(console.error);
  }
});
const external = (event: { data: { detail: string | { url: string } } }) => {
  const url = getExternalUrl(event.data.detail, localOrigins);
  if (url) { openExternal(url); }
};
events.on("will-navigate-" + window.webviewId, external);
events.on("new-window-open-" + window.webviewId, external);
${
  options.mode === "dev"
    ? `const control = ${JSON.stringify(join(generated, "control"))};
const timer = setInterval(() => {
  Bun.file(control).text().then((command) => {
    if (command) {
      clearInterval(timer);
      shutdown().catch(console.error);
    }
  }).catch(console.error);
}, 200);`
    : ""
}
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
      JSON.stringify({ config, serverEntry: options.serverEntry })
    );
  }
  await writeFile(join(generated, "main.ts"), renderRuntime(config, options, generated));
  await writeFile(join(generated, "control"), "");
  await writeFile(join(generated, "package.json"), '{"private":true,"type":"module"}\n');
  await writeFile(
    join(generated, "hutch.config.ts"),
    'export default { electrobun: { version: "2.0.2" } };\n'
  );
  const platform = { bundleCEF: false, bundleWGPU: false, defaultRenderer: "native" };
  const sdkConfig = {
    app: config.app,
    build: {
      mainProcess: "bun",
      bun: { entrypoint: "main.ts" },
      copy: options.mode === "build" ? { furin: "furin" } : {},
      mac: platform,
      win: platform,
      linux: platform,
    },
    runtime: { exitOnLastWindowClosed: false },
  };
  await writeFile(
    join(generated, "electrobun.config.ts"),
    `export default ${JSON.stringify(sdkConfig, null, 2)};\n`
  );
  return generated;
}
