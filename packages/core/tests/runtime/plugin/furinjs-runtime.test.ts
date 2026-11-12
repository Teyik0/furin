import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AnyElysia, Elysia } from "elysia";
import type { FurinOptions } from "../../../src/furin";
import type { CompileContext, EmbeddedAppData } from "../../../src/server/internal";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures";
import { createFixtureCompileContext } from "../../support/compile-context.ts";

const { furin } = await import("../../../src/furin");
const { revalidateTag } = await import("../../../src/server/auto-invalidate/index");
const { __resetCacheState, getSSGCache, ssgCache } = await import(
  "../../../src/server/cache/index"
);
const { __resetCompileContext, __setCompileContext } = await import("../../../src/server/internal");
const { getProductionTemplate, __resetTemplateState } = await import(
  "../../../src/server/render/template"
);
const { __setDevMode } = await import("../../../src/server/runtime-env");
const { generateProdIndexHtml } = await import("../../../src/server/render/shell");

const { allInstances, withInstance } = await import("../../../src/server/instance");

const tmpApps: TmpApp[] = [];
const originalCwd = process.cwd();
const originalArgv = process.argv.slice();
const originalPath = process.env.PATH;
const originalClientDir = process.env.FURIN_CLIENT_DIR;
const originalURL = globalThis.URL;

function rememberTmpApp(app: TmpApp): TmpApp {
  tmpApps.push(app);
  return app;
}

/** Reads the state of the single runtime created by the test. */
function inRuntime<T>(read: () => T): T {
  const [runtime, ...others] = allInstances();
  if (!runtime || others.length > 0) {
    throw new Error(`Expected one Furin runtime, found ${others.length + (runtime ? 1 : 0)}`);
  }
  return withInstance(runtime, read);
}

async function createTestApp(options: FurinOptions): Promise<AnyElysia> {
  return new Elysia().use(await furin(options));
}

function createCompileContext(appPath: string): Promise<CompileContext> {
  return createFixtureCompileContext(appPath, [{ file: "index.tsx", mode: "ssg", pattern: "/" }]);
}

async function setCompileContext(appPath: string, embedded?: EmbeddedAppData): Promise<void> {
  __setCompileContext({
    ...(await createCompileContext(appPath)),
    ...(embedded ? { embedded } : {}),
  });
}

function resetState(): void {
  __setDevMode(true);
  __resetTemplateState();
  __resetCacheState();
  __resetCompileContext();
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);
  if (originalPath === undefined) {
    delete process.env.PATH;
  } else {
    process.env.PATH = originalPath;
  }
  if (originalClientDir === undefined) {
    delete process.env.FURIN_CLIENT_DIR;
  } else {
    process.env.FURIN_CLIENT_DIR = originalClientDir;
  }
  globalThis.URL = originalURL;
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

beforeEach(resetState);
afterEach(resetState);

interface ClientDirCase {
  /** Client directory holding index.html, relative to the app. */
  dir: string;
  /** File created to stand in for the server executable, relative to the app. */
  executable: string | undefined;
  /** Overrides FURIN_CLIENT_DIR, the module URL, argv[1] and PATH when defined. */
  lookup:
    | { clientDirEnv: string }
    | {
        argv1: (appPath: string) => string;
        moduleUrl: (appPath: string) => string;
        path: (appPath: string) => string;
      };
  marker: string;
  name: string;
}

const httpModuleUrl = () => "http://example.com";
const missingArgv = () => "missing";
const emptyPath = () => "";

test.serial.each<ClientDirCase>([
  {
    dir: "custom-client",
    executable: undefined,
    lookup: { clientDirEnv: "custom-client" },
    marker: "custom",
    name: "from FURIN_CLIENT_DIR",
  },
  {
    dir: "module-home/client",
    executable: undefined,
    lookup: {
      argv1: missingArgv,
      moduleUrl: (appPath) => pathToFileURL(join(appPath, "module-home/furin.ts")).href,
      path: emptyPath,
    },
    marker: "module-client",
    name: "next to the module URL",
  },
  {
    dir: "bin/client",
    executable: "bin/server",
    lookup: {
      argv1: (appPath) => join(appPath, "bin/server"),
      moduleUrl: httpModuleUrl,
      path: emptyPath,
    },
    marker: "argv-client",
    name: "next to the argv server path",
  },
  {
    dir: "bin/client",
    executable: "bin/furin-server",
    lookup: {
      argv1: () => "furin-server",
      moduleUrl: () => "file:///$bunfs/furin.ts",
      path: (appPath) => join(appPath, "bin"),
    },
    marker: "path-client",
    name: "from the PATH binary",
  },
  {
    dir: ".furin/build/bun/client",
    executable: undefined,
    lookup: { argv1: missingArgv, moduleUrl: httpModuleUrl, path: emptyPath },
    marker: "fallback-client",
    name: "from the fallback built client directory",
  },
  {
    dir: "client",
    executable: undefined,
    lookup: { argv1: missingArgv, moduleUrl: httpModuleUrl, path: emptyPath },
    marker: "cwd-client",
    name: "from the cwd client directory",
  },
])("furin() production loads client assets $name", async ({ dir, executable, lookup, marker }) => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  mkdirSync(join(app.path, dir), { recursive: true });
  writeFileSync(join(app.path, dir, "index.html"), `<html>${marker}</html>`);
  if (executable !== undefined) {
    writeFileSync(join(app.path, executable), "");
  }
  if ("clientDirEnv" in lookup) {
    process.env.FURIN_CLIENT_DIR = lookup.clientDirEnv;
  } else {
    const moduleUrl = lookup.moduleUrl(app.path);
    class FakeModuleURL extends originalURL {
      constructor() {
        super(moduleUrl);
      }
    }
    globalThis.URL = FakeModuleURL;
    process.argv.length = 0;
    process.argv.push("bun", lookup.argv1(app.path));
    process.env.PATH = lookup.path(app.path);
  }

  await setCompileContext(app.path);
  const instance = await createTestApp({
    style: "tanstack",
    pagesDir: join(app.path, "src/pages"),
  });

  expect(instance).toBeInstanceOf(Elysia);
  expect(inRuntime(getProductionTemplate)).toContain(marker);
});

test.serial("furin() production rejects missing FURIN_CLIENT_DIR assets", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);
  process.env.FURIN_CLIENT_DIR = "missing-client";

  await setCompileContext(app.path);

  await expect(furin({ style: "tanstack", pagesDir: join(app.path, "src/pages") })).rejects.toThrow(
    "No pre-built assets found"
  );
});

test.serial(
  "compiled browser logging keeps ingest enabled despite an explicit runtime false",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    process.chdir(app.path);
    const clientDir = join(app.path, "embedded-client");
    mkdirSync(clientDir);
    writeFileSync(join(clientDir, "index.html"), "<html><body><!--app-html--></body></html>");
    __setCompileContext({
      ...(await createCompileContext(app.path)),
      clientLogging: true,
      embedded: { clientDir },
    });

    const instance = await createTestApp({
      style: "tanstack",
      clientLogging: false,
      pagesDir: join(app.path, "src/pages"),
    });
    const response = await instance.handle(
      new Request("http://localhost/_furin/ingest", {
        body: JSON.stringify([{ event: { msg: "browser log" } }]),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    expect(response.status).toBe(204);
  }
);

test.serial("furin() production hydrates embedded SSG cache", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html><!--ssr-outlet--></html>");
  process.env.FURIN_CLIENT_DIR = "client";

  __setCompileContext({
    ...(await createCompileContext(app.path)),
    ssgCache: {
      "/": {
        cachedAt: 123,
        html: "<html>prebuilt</html>",
        ndjson: "{}\n",
        status: 200,
      },
    },
  });

  const instance = await createTestApp({
    style: "tanstack",
    pagesDir: join(app.path, "src/pages"),
  });

  expect(instance).toBeInstanceOf(Elysia);
  expect(inRuntime(() => getSSGCache("/"))?.html).toBe("<html>prebuilt</html>");
});

test.serial(
  "a declared nested prefix serves prebuilt documents through nested containers",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    const rootPath = join(app.path, "src/pages/__root.tsx");
    writeFileSync(
      rootPath,
      (await Bun.file(rootPath).text()).replace('mode: "ssr"', 'mode: "ssg"')
    );
    const indexPath = join(app.path, "src/pages/index.tsx");
    writeFileSync(
      indexPath,
      `${(await Bun.file(indexPath).text()).replace(
        ".page(",
        '.loader(() => { runtimeLoaderReads += 1; throw new Error("Runtime loader forbidden"); }).page('
      )}\nexport let runtimeLoaderReads = 0;\n`
    );
    const prefix = "/outer/inner/admin";
    const clientDir = join(app.path, "client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(
      join(clientDir, "index.html"),
      generateProdIndexHtml(`${prefix}/_client/entry.js`, [], "build", undefined, false)
    );
    // The build already ran with the declared prefix as basePath.
    const prebuilt = `<html><head><link rel="stylesheet" href="${prefix}/_client/style.css"></head><body>prebuilt<script type="module" src="${prefix}/_client/entry.js"></script></body></html>`;
    __setCompileContext({
      ...(await createCompileContext(app.path)),
      prefix,
      ssgCache: { "/": { cachedAt: 123, html: prebuilt, ndjson: "{}\n", status: 200 } },
    });
    const guarded: string[] = [];
    const composed = new Elysia().use(
      new Elysia()
        .onBeforeHandle(({ request }) => {
          guarded.push(new URL(request.url).pathname);
        })
        .use(
          await furin({
            style: "tanstack",
            clientDir,
            pagesDir: join(app.path, "src/pages"),
            prefix,
          })
        )
    );

    const response = await composed.handle(new Request(`http://localhost${prefix}/`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(prebuilt);
    expect(guarded).toEqual([`${prefix}/`]);
    expect((await import(indexPath)).runtimeLoaderReads).toBe(0);
  }
);

test.serial("furin() production preloads route chunks from the compiled manifest", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, "index.html"),
    generateProdIndexHtml("/_client/entry.js", [], "build", undefined, false)
  );
  process.env.FURIN_CLIENT_DIR = "client";

  __setCompileContext({
    ...(await createCompileContext(app.path)),
    preloadManifest: { modules: {}, routes: { "/": ["/_client/index-abc.js"] } },
  });

  const instance = await createTestApp({
    style: "tanstack",
    pagesDir: join(app.path, "src/pages"),
  });
  const html = await (await instance.handle(new Request("http://localhost/"))).text();

  expect(html).toContain('<link rel="modulepreload" href="/_client/index-abc.js"/>');
});

test.serial("furin() production revalidates embedded SSG cache tags", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html><!--ssr-outlet--></html>");
  process.env.FURIN_CLIENT_DIR = "client";

  __setCompileContext({
    ...(await createCompileContext(app.path)),
    ssgCache: {
      "/": {
        cachedAt: 123,
        html: "<html>prebuilt</html>",
        ndjson: "{}\n",
        status: 200,
        tags: ["boards"],
      },
    },
  });

  await furin({ style: "tanstack", pagesDir: join(app.path, "src/pages") });

  expect(await revalidateTag("boards")).toBe(true);
  expect(inRuntime(() => ssgCache.has("/"))).toBe(false);
});

test.serial("furin() production rejects embedded context without HTML template", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "embedded-client");
  mkdirSync(clientDir);
  await setCompileContext(app.path, { clientDir });

  await expect(furin({ style: "tanstack", pagesDir: join(app.path, "src/pages") })).rejects.toThrow(
    "HTML template"
  );
});

test.serial("furin() production serves embedded client and public assets", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "embedded-client");
  const publicDir = join(app.path, "embedded-public");
  mkdirSync(clientDir);
  mkdirSync(publicDir);
  const clientAsset = join(clientDir, "app.js");
  const publicAsset = join(publicDir, "logo.png");
  writeFileSync(join(clientDir, "index.html"), "<html><!--ssr-outlet--></html>");
  writeFileSync(clientAsset, "console.log('client');");
  writeFileSync(publicAsset, "logo");

  await setCompileContext(app.path, {
    clientDir,
    publicDir,
  });

  const instance = await createTestApp({
    style: "tanstack",
    pagesDir: join(app.path, "src/pages"),
  });
  const okClient = await instance.handle(new Request("http://furin/_client/app.js"));
  const okPublic = await instance.handle(new Request("http://furin/public/logo.png"));
  const missClient = await instance.handle(new Request("http://furin/_client/missing.js"));
  const missPublic = await instance.handle(new Request("http://furin/public/missing.png"));

  expect(okClient.status).toBe(200);
  expect(okPublic.status).toBe(200);
  expect(missClient.status).toBe(404);
  expect(missPublic.status).toBe(404);
});
