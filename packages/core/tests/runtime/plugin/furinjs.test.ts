import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Elysia from "elysia";
import type { FurinOptions } from "../../../src/furin";
import { routeModuleSpecifier } from "../../../src/plugin/routes.ts";
import type { CompileContext } from "../../../src/server/internal";
import { evlogOptionsMock, initLoggerOptionsMock, resetEvlogMock } from "../../setup/evlog-mock";
import { createTmpApp, removeAppPath, type TmpApp, writeAppFile } from "../../support/app-fixtures";
import { runCli } from "../../support/process";

const { furin } = await import("../../../src/furin");
const { __resetCompileContext, __setCompileContext } = await import("../../../src/server/internal");
const { __resetTemplateState } = await import("../../../src/server/render/template");
const { __setDevMode } = await import("../../../src/server/runtime-env");

const originalCwd = process.cwd();
const originalArgv = process.argv.slice();
const tmpApps: TmpApp[] = [];

function rememberTmpApp(app: TmpApp): TmpApp {
  tmpApps.push(app);
  return app;
}

async function createTestApp(options: FurinOptions): Promise<Elysia> {
  return new Elysia().use(await furin(options));
}

function resetState(): void {
  resetEvlogMock();
  __setDevMode(true);
  __resetTemplateState();
  __resetCompileContext();
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

async function waitForFileContent(path: string, expected: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!(existsSync(path) && readFileSync(path, "utf8").includes(expected))) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${path}`);
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for a native fs event
    await Bun.sleep(20);
  }
}

async function createBuiltRouteContext(appPath: string): Promise<CompileContext> {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const indexPath = join(appPath, "src/pages/index.tsx");
  const blogSlugPath = join(appPath, "src/pages/blog/[slug].tsx");

  const [rootMod, indexMod, blogSlugMod] = await Promise.all([
    import(rootPath),
    import(indexPath),
    import(blogSlugPath),
  ]);
  const rootRoute = rootMod.route as { elysia: Elysia };
  const indexRoute = indexMod.route as { elysia: Elysia };
  const blogSlugRoute = blogSlugMod.route as { elysia: Elysia };
  const nativeRoutes = new Elysia().use(
    rootRoute.elysia
      .use(new Elysia().use(indexRoute.elysia))
      .use(new Elysia({ prefix: "/blog/:slug" }).use(blogSlugRoute.elysia))
  );

  return {
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
      [blogSlugPath]: blogSlugMod,
    },
    nativeRoutes,
    rootConventions: {},
    rootPath,
    routeMetadata: {
      [indexPath]: { segmentBoundaries: [] },
      [blogSlugPath]: { segmentBoundaries: [] },
    },
    routes: [
      { mode: "ssg", path: indexPath, pattern: "/" },
      { mode: "ssg", path: blogSlugPath, pattern: "/blog/:slug" },
    ],
  };
}

async function setBuiltRouteContext(appPath: string): Promise<void> {
  __setCompileContext(await createBuiltRouteContext(appPath));
}

beforeEach(resetState);
afterEach(resetState);

test.serial("furin() writes dev files in development", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({
    pagesDir: join(app.path, "src/pages"),
  });

  expect(instance).toBeInstanceOf(Elysia);
  expect(existsSync(join(app.path, ".furin/index.html"))).toBe(true);
  expect(existsSync(join(app.path, ".furin/_hydrate.tsx"))).toBe(true);
  expect(existsSync(join(app.path, "furin-env.d.ts"))).toBe(true);
});

test.serial(
  "furin() forwards evlog sampling without passing it to the Elysia middleware",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    __setDevMode(true);
    process.chdir(app.path);
    const sampling = {
      keep: [{ duration: 1000 }, { status: 400 }],
      rates: { info: 10 },
    };

    await createTestApp({
      logger: { sampling },
      pagesDir: join(app.path, "src/pages"),
    });

    expect(initLoggerOptionsMock).toHaveBeenCalledWith({
      env: { service: "furin" },
      sampling,
    });
    expect(evlogOptionsMock.mock.calls[0]?.[0]).not.toHaveProperty("sampling");
  }
);

test.serial("furin() scaffolds empty root and index route files into a working app", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  const rootPath = join(pagesDir, "root.tsx");
  const indexPath = join(pagesDir, "index.tsx");
  writeFileSync(rootPath, "\n");
  writeFileSync(indexPath, "   \n");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  const response = await instance.handle(new Request("http://furin/"));

  expect(response.status).toBe(200);
  expect(readFileSync(rootPath, "utf8")).toContain("defineRootRoute()");
  expect(readFileSync(indexPath, "utf8")).toContain('.config({ layout: rootRoute, mode: "ssg" })');
});

test.serial("furin() refreshes route types after a topology change", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  const typesPath = join(app.path, "furin-env.d.ts");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  instance.listen(0);
  try {
    writeAppFile(
      app.path,
      "src/pages/settings.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssg" })',
        "  .page(() => <main>Settings</main>);",
      ].join("\n")
    );

    await waitForFileContent(typesPath, '"/settings": typeof import("./src/pages/settings").route');
  } finally {
    await instance.stop();
  }
});

test.serial("furin() restores a removed route layout while the dev server is running", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  const routePath = join(pagesDir, "index.tsx");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  instance.listen(0);
  try {
    const source = readFileSync(routePath, "utf8");
    writeAppFile(app.path, "src/pages/index.tsx", source.replace("layout: rootRoute, ", ""));

    await waitForFileContent(routePath, ".config({ layout: rootRoute, mode:");
  } finally {
    await instance.stop();
  }
});

test.serial("furin() rejects an ambiguous route config at boot", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "const selectLayout = () => rootRoute;",
      "export const route = defineRoute()",
      '  .config({ layout: selectLayout(), mode: "ssg" })',
      "  .page(() => <main>Index</main>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  await expect(furin({ pagesDir })).rejects.toThrow(
    `${join(pagesDir, "index.tsx")}: use a static layout route reference`
  );
});

test.serial("furin() registers native routes in dev without replacing SSR responses", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .loader(() => ({ title: 'Native route' }))",
      "  .page(({ data }) => <main>{data.title}</main>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  const nativeModule = (await import(routeModuleSpecifier({ pagesDir, prefix: "" }))) as {
    furinApp: { handle: (request: Request) => Promise<Response> };
  };
  const nativeResponse = await nativeModule.furinApp.handle(new Request("http://furin/"));
  const ssrResponse = await instance.handle(new Request("http://furin/"));

  expect(await nativeResponse.json()).toEqual({ title: "Native route" });
  expect(ssrResponse.headers.get("content-type")).toContain("text/html");
  expect(await ssrResponse.text()).toContain("Native route");
});

test.serial(
  "native layouts validate their schema and render through the loader pipeline",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const pagesDir = join(app.path, "src/pages");
    writeAppFile(
      app.path,
      "src/pages/boards/_route.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        'import { route as rootRoute } from "../root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr", query: t.Object({ locale: t.String() }) })',
        "  .loader(() => ({ organization: 'Furin' }))",
        "  .layout(({ children }) => <section>{children}</section>);",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/boards/[id].tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        'import { route as parentRoute } from "./_route";',
        "export const route = defineRoute()",
        '  .config({ layout: parentRoute, mode: "ssr", params: t.Object({ id: t.Number() }) })',
        "  .loader(async (context) => {",
        "    const parent = context as typeof context & { organization: Promise<string> | string; query: { locale: string } };",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source fixture contains a template literal
        "    return { label: `${await parent.organization}:${context.params.id}:${parent.query.locale}` };",
        "  })",
        "  .page(({ data }) => <main>{data.label}</main>);",
      ].join("\n")
    );
    __setDevMode(true);
    process.chdir(app.path);

    const instance = await createTestApp({ pagesDir });
    const valid = await instance.handle(new Request("http://furin/boards/42?locale=fr"));
    const invalid = await instance.handle(new Request("http://furin/boards/42"));

    expect(valid.status).toBe(200);
    expect(await valid.text()).toContain("Furin:42:fr");
    expect(invalid.status).toBe(422);
  }
);

test.serial("native routes preserve deferred renderer streaming", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defer, defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .loader(() => defer({ slow: Promise.resolve('later'), title: 'Native deferred' }))",
      "  .page(({ data }) => <main>{data.title}</main>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  const response = await instance.handle(new Request("http://furin/"));
  const html = await response.text();

  expect(response.status).toBe(200);
  expect(html).toContain("Native deferred");
  expect(html).toContain("later");
  expect(html).toContain("window.__FURIN_ROUTE_FRAME_STREAM__.push");
});

test.serial("furin() excludes internal DevTools requests from logging", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);

  await furin({
    pagesDir: join(app.path, "src/pages"),
  });

  const loggerOptions = evlogOptionsMock.mock.calls.at(-1)?.[0];
  expect(loggerOptions?.exclude).toContain("/_furin/devtools/**");
});

test.serial("furin() production without build output throws", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  await expect(furin({ pagesDir: join(app.path, "src/pages") })).rejects.toThrow("furin build");
});

test.serial("furin() production plugin starts from built output", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const result = await runCli(["build", "--target", "bun"], { cwd: app.path });
  expect(result.exitCode).toBe(0);

  __setDevMode(false);
  process.chdir(app.path);
  process.argv[1] = join(app.path, ".furin/build/bun/server.js");

  await setBuiltRouteContext(app.path);

  const instance = await createTestApp({
    pagesDir: join(app.path, "src/pages"),
  });
  const htmlResponse = await instance.handle(new Request("http://furin/"));
  const snapshotResponse = await instance.handle(
    new Request("http://furin/_furin/devtools/snapshot")
  );
  const clientResponse = await instance.handle(
    new Request("http://furin/_furin/devtools/client.js")
  );
  const eventsResponse = await instance.handle(new Request("http://furin/_furin/devtools/events"));

  expect(htmlResponse.status).toBe(200);
  expect(await htmlResponse.text()).not.toContain("furin-devtools");
  expect(snapshotResponse.status).toBe(404);
  expect(clientResponse.status).toBe(404);
  expect(eventsResponse.status).toBe(404);
  await eventsResponse.body?.cancel();

  const server = instance.listen(0);

  try {
    await Bun.sleep(50);
    expect(server.server).toBeDefined();
  } finally {
    server.stop();
  }
});

test.serial(
  "furin() production dispatches defined pages through the compiled native app",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        "  .loader(() => ({ title: 'Compiled native' }))",
        "  .page(({ data }) => <main>{data.title}</main>);",
      ].join("\n")
    );
    __setDevMode(false);
    process.chdir(app.path);

    const context = await createBuiltRouteContext(app.path);
    const templatePath = join(app.path, "native-template.html");
    writeFileSync(
      templatePath,
      '<html><head><!--furin-head--></head><body><div id="root"><!--ssr-outlet--></div></body></html>'
    );
    let nativeRequests = 0;
    const nativeRoutes = new Elysia().get("/", (routeContext) => {
      nativeRequests += 1;
      const { $furinRender } = routeContext as typeof routeContext & {
        $furinRender: (ctx: typeof routeContext) => unknown;
      };
      return $furinRender(routeContext);
    });
    __setCompileContext({
      ...context,
      embedded: { assets: {}, template: templatePath },
      nativeRoutes,
      routes: context.routes.map((route) =>
        route.pattern === "/" ? { ...route, mode: "ssr" } : route
      ),
    });

    const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });
    const response = await instance.handle(new Request("http://furin/"));

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Compiled native");
    expect(nativeRequests).toBe(1);
  }
);

test.serial("furin() serves embedded assets in production", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const templatePath = join(app.path, "fake-template.html");
  writeFileSync(templatePath, "<html><head></head><body><!--ssr-outlet--></body></html>");
  const clientAssetPath = join(app.path, "client.js");
  const publicAssetPath = join(app.path, "logo.png");
  writeFileSync(clientAssetPath, "console.log('client');");
  writeFileSync(publicAssetPath, "logo");

  __setCompileContext({
    ...(await createBuiltRouteContext(app.path)),
    embedded: {
      assets: {
        "/_client/app.js": clientAssetPath,
        "/public/logo.png": publicAssetPath,
      },
      template: templatePath,
    },
  });

  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });
  expect(instance).toBeInstanceOf(Elysia);

  const okClient = await instance.handle(new Request("http://furin/_client/app.js"));
  const okPublic = await instance.handle(new Request("http://furin/public/logo.png"));
  const missClient = await instance.handle(new Request("http://furin/_client/missing.js"));
  const missPublic = await instance.handle(new Request("http://furin/public/missing.png"));

  expect(okClient.status).toBe(200);
  expect(okPublic.status).toBe(200);
  expect(missClient.status).toBe(404);
  expect(missPublic.status).toBe(404);
});

test.serial("furin() rejects dev pages without a root layout", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  removeAppPath(app.path, "src/pages/root.tsx");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "furin";',
      "export const route = defineRoute().config({ mode: 'ssg' })",
      "  .page(() => <main>No root</main>);",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    [
      'import { defineRoute } from "furin";',
      'import { t } from "elysia";',
      "export const route = defineRoute().config({ mode: 'ssg',",
      "  params: t.Object({ slug: t.String() }),",
      "  staticParams: () => [{ slug: 'hello-world' }],",
      "}).page(() => <article>No root blog</article>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  await expect(
    furin({
      pagesDir: join(app.path, "src/pages"),
    })
  ).rejects.toThrow();
});
