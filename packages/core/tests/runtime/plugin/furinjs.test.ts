import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Elysia from "elysia";
import type { CompileContext } from "../../../src/server/internal";
import { evlogOptionsMock, resetEvlogMock } from "../../setup/evlog-mock";
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

async function createBuiltRouteContext(appPath: string): Promise<CompileContext> {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const indexPath = join(appPath, "src/pages/index.tsx");
  const blogSlugPath = join(appPath, "src/pages/blog/[slug].tsx");

  const [rootMod, indexMod, blogSlugMod] = await Promise.all([
    import(rootPath),
    import(indexPath),
    import(blogSlugPath),
  ]);

  return {
    modules: {
      [rootPath]: rootMod,
      [indexPath]: indexMod,
      [blogSlugPath]: blogSlugMod,
    },
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

  const instance = await furin({
    pagesDir: join(app.path, "src/pages"),
  });

  expect(instance).toBeInstanceOf(Elysia);
  expect(existsSync(join(app.path, ".furin/index.html"))).toBe(true);
  expect(existsSync(join(app.path, ".furin/_hydrate.tsx"))).toBe(true);
  expect(existsSync(join(app.path, "furin-env.d.ts"))).toBe(true);
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

  const plugin = await furin({
    pagesDir: join(app.path, "src/pages"),
  });
  const htmlResponse = await plugin.handle(new Request("http://furin/"));
  const snapshotResponse = await plugin.handle(
    new Request("http://furin/_furin/devtools/snapshot")
  );
  const clientResponse = await plugin.handle(new Request("http://furin/_furin/devtools/client.js"));
  const eventsResponse = await plugin.handle(new Request("http://furin/_furin/devtools/events"));

  expect(htmlResponse.status).toBe(200);
  expect(await htmlResponse.text()).not.toContain("furin-devtools");
  expect(snapshotResponse.status).toBe(404);
  expect(clientResponse.status).toBe(404);
  expect(eventsResponse.status).toBe(404);
  await eventsResponse.body?.cancel();

  const server = new Elysia().use(plugin).listen(0);

  try {
    await Bun.sleep(50);
    expect(server.server).toBeDefined();
  } finally {
    server.stop();
  }
});

test.serial("furin() serves embedded assets in production", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  const clientDir = join(app.path, "embedded-client");
  const publicDir = join(app.path, "embedded-public");
  mkdirSync(clientDir);
  mkdirSync(publicDir);
  writeFileSync(
    join(clientDir, "index.html"),
    "<html><head></head><body><!--ssr-outlet--></body></html>"
  );
  const clientAssetPath = join(clientDir, "app.js");
  const publicAssetPath = join(publicDir, "logo.png");
  writeFileSync(clientAssetPath, "console.log('client');");
  writeFileSync(publicAssetPath, "logo");

  __setCompileContext({
    ...(await createBuiltRouteContext(app.path)),
    embedded: {
      clientDir,
      publicDir,
    },
  });

  const instance = await furin({ pagesDir: join(app.path, "src/pages") });
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
      'import { createRoute } from "furin/client";',
      "const route = createRoute({ mode: 'ssg' });",
      "export default route.page({ component: () => <main>No root</main> });",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    [
      'import { createRoute } from "furin/client";',
      "const route = createRoute({ mode: 'ssg' });",
      "export default route.page({",
      "  staticParams: () => [{ slug: 'hello-world' }],",
      "  component: () => <article>No root blog</article>,",
      "});",
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
