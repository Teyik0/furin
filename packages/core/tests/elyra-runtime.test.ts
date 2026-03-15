import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Elysia } from "elysia";
import { elyra } from "../src/elyra.ts";
import { __resetCompileContext, __setCompileContext } from "../src/internal.ts";
import { getProductionTemplate, setProductionTemplatePath } from "../src/render/template.ts";
import { __setDevMode } from "../src/runtime-env.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalCwd = process.cwd();
const originalArgv = process.argv.slice();
const originalPath = process.env.PATH;
const originalClientDir = process.env.ELYRA_CLIENT_DIR;
const originalURL = globalThis.URL;

function rememberTmpApp<T extends { cleanup: () => void }>(app: T): T {
  tmpApps.push(app);
  return app;
}

async function setCompileContext(
  appPath: string,
  embedded?: { template: string; assets: Record<string, string> }
) {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const indexPath = join(appPath, "src/pages/index.tsx");
  const [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);

  __setCompileContext({
    rootPath,
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
    },
    routes: [{ pattern: "/", path: indexPath, mode: "ssg" }],
    ...(embedded ? { embedded } : {}),
  });
}

function resetProcessState(): void {
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);

  if (originalPath === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to properly unset a variable
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }

  if (originalClientDir === undefined) {
    // biome-ignore lint/performance/noDelete: process.env requires delete to properly unset a variable
    delete process.env.ELYRA_CLIENT_DIR;
  } else {
    process.env.ELYRA_CLIENT_DIR = originalClientDir;
  }
}

afterEach(() => {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  resetProcessState();
  globalThis.URL = originalURL;

  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("elyra() production runtime resolution", () => {
  test("uses ELYRA_CLIENT_DIR when provided", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const clientDir = join(app.path, "custom-client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html>custom</html>");
    process.env.ELYRA_CLIENT_DIR = "custom-client";

    await setCompileContext(app.path);
    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    expect(instance).toBeInstanceOf(Elysia);
    expect(getProductionTemplate()).toContain("custom");
  });

  test("throws when ELYRA_CLIENT_DIR has no index.html", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);
    process.env.ELYRA_CLIENT_DIR = "missing-client";

    await setCompileContext(app.path);
    expect(elyra({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow(
      "No pre-built assets found"
    );
  });

  test("module URL resolution returns client dir when index.html exists", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const moduleRoot = join(app.path, "module-home");
    const moduleClientDir = join(moduleRoot, "client");
    mkdirSync(moduleClientDir, { recursive: true });
    writeFileSync(join(moduleClientDir, "index.html"), "<html>module-client</html>");

    const fakeModuleUrl = pathToFileURL(join(moduleRoot, "elyra.ts")).href;
    class FakeURL extends originalURL {
      constructor(_input: string, _base?: string | URL) {
        super(fakeModuleUrl);
      }
    }
    globalThis.URL = FakeURL as typeof URL;

    process.argv.length = 0;
    process.argv.push("bun", "missing");
    process.env.PATH = "";

    await setCompileContext(app.path);
    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    expect(instance).toBeInstanceOf(Elysia);
    expect(getProductionTemplate()).toContain("module-client");
  });

  test("non-file module URL falls back to absolute argv path", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const binDir = join(app.path, "bin");
    const serverPath = join(binDir, "server");
    const clientDir = join(binDir, "client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(serverPath, "");
    writeFileSync(join(clientDir, "index.html"), "<html>argv-client</html>");

    class FakeURL extends originalURL {
      constructor(_input: string, _base?: string | URL) {
        super("http://example.com");
      }
    }
    globalThis.URL = FakeURL as typeof URL;

    process.argv.length = 0;
    process.argv.push("bun", serverPath);
    process.env.PATH = "";

    await setCompileContext(app.path);
    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    expect(instance).toBeInstanceOf(Elysia);
    expect(getProductionTemplate()).toContain("argv-client");
  });

  test("bunfs module URL falls back to PATH lookup", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const binDir = join(app.path, "bin");
    const binaryName = "elyra-server";
    const binaryPath = join(binDir, binaryName);
    const clientDir = join(binDir, "client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(binaryPath, "");
    writeFileSync(join(clientDir, "index.html"), "<html>path-client</html>");

    class FakeURL extends originalURL {
      constructor(_input: string, _base?: string | URL) {
        super("file:///$bunfs/elyra.ts");
      }
    }
    globalThis.URL = FakeURL as typeof URL;

    process.argv.length = 0;
    process.argv.push("bun", binaryName);
    process.env.PATH = binDir;

    await setCompileContext(app.path);
    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    expect(instance).toBeInstanceOf(Elysia);
    expect(getProductionTemplate()).toContain("path-client");
  });

  test("fallback uses .elyra/build/bun/client when present", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const fallbackDir = join(app.path, ".elyra/build/bun/client");
    mkdirSync(fallbackDir, { recursive: true });
    writeFileSync(join(fallbackDir, "index.html"), "<html>fallback-client</html>");

    class FakeURL extends originalURL {
      constructor(_input: string, _base?: string | URL) {
        super("http://example.com");
      }
    }
    globalThis.URL = FakeURL as typeof URL;

    process.argv.length = 0;
    process.argv.push("bun", "missing");
    process.env.PATH = "";

    await setCompileContext(app.path);
    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    expect(instance).toBeInstanceOf(Elysia);
    expect(getProductionTemplate()).toContain("fallback-client");
  });

  test("fallback uses ./client when build client is missing", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const clientDir = join(app.path, "client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(join(clientDir, "index.html"), "<html>cwd-client</html>");

    class FakeURL extends originalURL {
      constructor(_input: string, _base?: string | URL) {
        super("http://example.com");
      }
    }
    globalThis.URL = FakeURL as typeof URL;

    process.argv.length = 0;
    process.argv.push("bun", "missing");
    process.env.PATH = "";

    await setCompileContext(app.path);
    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    expect(instance).toBeInstanceOf(Elysia);
    expect(getProductionTemplate()).toContain("cwd-client");
  });

  test("embedded missing template throws", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    await setCompileContext(app.path, { template: "", assets: {} });
    expect(elyra({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow("HTML template");
  });

  test("embedded assets serve /_client and /public", async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);

    const templatePath = join(app.path, "template.html");
    const clientAsset = join(app.path, "client.js");
    const publicAsset = join(app.path, "logo.png");
    writeFileSync(templatePath, "<html><!--ssr-outlet--></html>");
    writeFileSync(clientAsset, "console.log('client');");
    writeFileSync(publicAsset, "logo");

    await setCompileContext(app.path, {
      template: templatePath,
      assets: {
        "/_client/app.js": clientAsset,
        "/public/logo.png": publicAsset,
      },
    });

    const instance = await elyra({ pagesDir: join(app.path, "src/pages") });

    const okClient = await instance.handle(new Request("http://elyra/_client/app.js"));
    const okPublic = await instance.handle(new Request("http://elyra/public/logo.png"));
    const missClient = await instance.handle(new Request("http://elyra/_client/missing.js"));
    const missPublic = await instance.handle(new Request("http://elyra/public/missing.png"));

    expect(okClient.status).toBe(200);
    expect(okPublic.status).toBe(200);
    expect(missClient.status).toBe(404);
    expect(missPublic.status).toBe(404);
  });
});
