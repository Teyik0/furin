import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type AnyElysia, Elysia } from "elysia";
import type { FurinOptions } from "../../../src/furin";
import type { CompileContext, EmbeddedAppData } from "../../../src/server/internal";
import { resetEvlogMock } from "../../setup/evlog-mock";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures";

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

const tmpApps: TmpApp[] = [];
const HEAD_JSON_RE = /id="__FURIN_HEAD__"[^>]*>([\s\S]*?)<\/script>/;
const originalCwd = process.cwd();
const originalArgv = process.argv.slice();
const originalPath = process.env.PATH;
const originalClientDir = process.env.FURIN_CLIENT_DIR;
const originalURL = globalThis.URL;

function rememberTmpApp(app: TmpApp): TmpApp {
  tmpApps.push(app);
  return app;
}

async function createTestApp(options: FurinOptions): Promise<AnyElysia> {
  return new Elysia().use(await furin(options));
}

async function createCompileContext(appPath: string): Promise<CompileContext> {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const indexPath = join(appPath, "src/pages/index.tsx");
  const [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);
  const rootRoute = rootMod.route as { elysia: Elysia };
  const indexRoute = indexMod.route as { elysia: Elysia };
  const nativeRoutes = new Elysia().use(rootRoute.elysia.use(new Elysia().use(indexRoute.elysia)));

  return {
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
    },
    nativeRoutes,
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
    },
    routes: [{ mode: "ssg", path: indexPath, pattern: "/" }],
  };
}

async function setCompileContext(appPath: string, embedded?: EmbeddedAppData): Promise<void> {
  __setCompileContext({
    ...(await createCompileContext(appPath)),
    ...(embedded ? { embedded } : {}),
  });
}

function resetState(): void {
  resetEvlogMock();
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

test.serial("furin() production loads client assets from FURIN_CLIENT_DIR", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "custom-client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html>custom</html>");
  process.env.FURIN_CLIENT_DIR = "custom-client";

  await setCompileContext(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("custom");
});

test.serial("furin() production rejects missing FURIN_CLIENT_DIR assets", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);
  process.env.FURIN_CLIENT_DIR = "missing-client";

  await setCompileContext(app.path);

  await expect(furin({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow(
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

test.serial("furin() production resolves client assets next to module URL", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const moduleRoot = join(app.path, "module-home");
  const moduleClientDir = join(moduleRoot, "client");
  mkdirSync(moduleClientDir, { recursive: true });
  writeFileSync(join(moduleClientDir, "index.html"), "<html>module-client</html>");

  const fakeModuleUrl = pathToFileURL(join(moduleRoot, "furin.ts")).href;
  class FakeModuleURL extends originalURL {
    constructor() {
      super(fakeModuleUrl);
    }
  }
  globalThis.URL = FakeModuleURL;
  process.argv.length = 0;
  process.argv.push("bun", "missing");
  process.env.PATH = "";

  await setCompileContext(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("module-client");
});

test.serial("furin() production resolves client assets next to argv server path", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const binDir = join(app.path, "bin");
  const serverPath = join(binDir, "server");
  const clientDir = join(binDir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(serverPath, "");
  writeFileSync(join(clientDir, "index.html"), "<html>argv-client</html>");

  class FakeHttpURL extends originalURL {
    constructor() {
      super("http://example.com");
    }
  }
  globalThis.URL = FakeHttpURL;
  process.argv.length = 0;
  process.argv.push("bun", serverPath);
  process.env.PATH = "";

  await setCompileContext(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("argv-client");
});

test.serial("furin() production resolves client assets from PATH binary", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const binDir = join(app.path, "bin");
  const binaryName = "furin-server";
  const binaryPath = join(binDir, binaryName);
  const clientDir = join(binDir, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(binaryPath, "");
  writeFileSync(join(clientDir, "index.html"), "<html>path-client</html>");

  class FakeBunfsURL extends originalURL {
    constructor() {
      super("file:///$bunfs/furin.ts");
    }
  }
  globalThis.URL = FakeBunfsURL;
  process.argv.length = 0;
  process.argv.push("bun", binaryName);
  process.env.PATH = binDir;

  await setCompileContext(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("path-client");
});

test.serial("furin() production resolves fallback built client directory", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const fallbackDir = join(app.path, ".furin/build/bun/client");
  mkdirSync(fallbackDir, { recursive: true });
  writeFileSync(join(fallbackDir, "index.html"), "<html>fallback-client</html>");

  class FakeHttpURL extends originalURL {
    constructor() {
      super("http://example.com");
    }
  }
  globalThis.URL = FakeHttpURL;
  process.argv.length = 0;
  process.argv.push("bun", "missing");
  process.env.PATH = "";

  await setCompileContext(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("fallback-client");
});

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

  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getSSGCache("/")?.html).toBe("<html>prebuilt</html>");
});

test.serial(
  "prebuilt SSG documents preserve physical URLs under nested parent mounts",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(false);
    const rootPath = join(app.path, "src/pages/root.tsx");
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
    const clientDir = join(app.path, "client");
    mkdirSync(clientDir, { recursive: true });
    writeFileSync(
      join(clientDir, "index.html"),
      generateProdIndexHtml(
        "/admin/_client/entry.js",
        ["/admin/_client/style.css"],
        "build",
        undefined,
        false
      )
    );
    __setCompileContext({
      ...(await createCompileContext(app.path)),
      prefix: "/admin",
      ssgCache: {
        "/": {
          cachedAt: 123,
          status: 200,
          ndjson: "{}\n",
          html: '<html><head><meta name="furin-base-path" content="/admin"><link rel="stylesheet" href="/admin/_client/style.css"><script src="/admin/_client/head.js"></script><link rel="icon" href="/admin/custom.ico"><link rel="modulepreload" href="/admin/custom-module.js"><link rel="alternate" href="/admin?mode=x#tab"><link rel="alternate" href="/admin#fragment"><link rel="alternate" href="https://example.org/admin?mode=x"></head><body>prebuilt<script id="__FURIN_DATA__" type="application/json">{"snapshot":"/admin/_client/private-value.js"}</script><script id="__FURIN_HEAD__" type="application/json">{"links":[{"rel":"stylesheet","href":"/admin/_client/style.css"},{"rel":"alternate","href":"/admin?mode=x#tab"},{"rel":"alternate","href":"/admin#fragment"},{"rel":"alternate","href":"https://example.org/admin?mode=x"}],"scripts":[{"src":"/admin/_client/head.js"},{"children":"window.snapshot=\\"/admin/_client/private-value.js\\";"}],"meta":[{"name":"furin-base-path","content":"/admin"},{"title":"Snapshot title"}]}</script><script id="__FURIN_SYNC__" type="application/json">{"path":"/sync"}</script><script>window.authorValue="/admin/_client/private-value.js";</script><script src="/admin/author.js"></script><script type="module" src="/admin/_client/entry.js"></script></body></html>',
        },
      },
    });
    const plugin = await furin({
      prefix: "/admin",
      pagesDir: join(app.path, "src/pages"),
      clientDir,
    });
    const composed = new Elysia({ prefix: "/outer" }).use(
      new Elysia({ prefix: "/inner" }).use(plugin)
    );
    const response = await composed.handle(new Request("http://localhost/outer/inner/admin/"));
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('name="furin-base-path" content="/outer/inner/admin"');
    expect(html).toContain('src="/outer/inner/admin/_client/entry.js"');
    expect(html).toContain('href="/outer/inner/admin/_client/style.css"');
    expect(html).toContain('{"snapshot":"/admin/_client/private-value.js"}');
    expect(html).toContain('window.authorValue="/admin/_client/private-value.js";');
    expect(html).toContain('src="/admin/author.js"');
    expect(html).toContain('{"path":"/sync"}');
    expect(html).toContain('"name":"furin-base-path","content":"/outer/inner/admin"');
    expect(html).toContain('src="/outer/inner/admin/_client/head.js"');
    expect(html).toContain('href="/outer/inner/admin/custom.ico"');
    expect(html).toContain('href="/outer/inner/admin/custom-module.js"');
    expect(html).toContain('href="/outer/inner/admin?mode=x#tab"');
    expect(html).toContain('href="/outer/inner/admin#fragment"');
    expect(html).toContain('href="https://example.org/admin?mode=x"');
    const serializedHead = html.match(HEAD_JSON_RE)?.[1];
    expect(JSON.parse(serializedHead ?? "{}")).toMatchObject({
      links: [
        { rel: "stylesheet", href: "/outer/inner/admin/_client/style.css" },
        { rel: "alternate", href: "/outer/inner/admin?mode=x#tab" },
        { rel: "alternate", href: "/outer/inner/admin#fragment" },
        { rel: "alternate", href: "https://example.org/admin?mode=x" },
      ],
      scripts: [
        { src: "/outer/inner/admin/_client/head.js" },
        { children: 'window.snapshot="/admin/_client/private-value.js";' },
      ],
    });
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

  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });
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

  await furin({ pagesDir: join(app.path, "src/pages") });

  expect(await revalidateTag("boards")).toBe(true);
  expect(ssgCache.has("/")).toBe(false);
});

test.serial("furin() production falls back to cwd client directory", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<html>cwd-client</html>");
  class FakeHttpURL extends originalURL {
    constructor() {
      super("http://example.com");
    }
  }
  globalThis.URL = FakeHttpURL;
  process.argv.length = 0;
  process.argv.push("bun", "missing");
  process.env.PATH = "";

  await setCompileContext(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });

  expect(instance).toBeInstanceOf(Elysia);
  expect(getProductionTemplate()).toContain("cwd-client");
});

test.serial("furin() production rejects embedded context without HTML template", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "embedded-client");
  mkdirSync(clientDir);
  await setCompileContext(app.path, { clientDir });

  await expect(furin({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow("HTML template");
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

  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });
  const okClient = await instance.handle(new Request("http://furin/_client/app.js"));
  const okPublic = await instance.handle(new Request("http://furin/public/logo.png"));
  const missClient = await instance.handle(new Request("http://furin/_client/missing.js"));
  const missPublic = await instance.handle(new Request("http://furin/public/missing.png"));

  expect(okClient.status).toBe(200);
  expect(okPublic.status).toBe(200);
  expect(missClient.status).toBe(404);
  expect(missPublic.status).toBe(404);
});
