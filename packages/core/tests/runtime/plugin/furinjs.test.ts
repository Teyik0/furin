import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Elysia, { type AnyElysia } from "elysia";
import type { FurinOptions } from "../../../src/furin";
import { routeModuleSpecifier } from "../../../src/plugin/route-tree.ts";
import { createMemoryPageCache } from "../../../src/server/cache/page-cache.ts";
import type { CompileContext } from "../../../src/server/internal";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import {
  copyPagesForPrefix,
  createTmpApp,
  keyPagesForPrefix,
  removeAppPath,
  type TmpApp,
  writeAppFile,
} from "../../support/app-fixtures";
import { captureEvlogEvents } from "../../support/evlog-capture.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http";
import { runCli, startProcess } from "../../support/process";

const { furin, isFurinPageRequest, revalidatePath, revalidateTag } = await import(
  "../../../src/furin"
);
const { __resetCompileContext, __setCompileContext } = await import("../../../src/server/internal");
const { __resetTemplateState } = await import("../../../src/server/render/template");
const { __setDevMode } = await import("../../../src/server/runtime-env");

const originalCwd = process.cwd();
const originalArgv = process.argv.slice();
const tmpApps: TmpApp[] = [];
const ROOT_CATCH_ALL_PAGE = [
  'import { defineRoute, notFound } from "@teyik0/furin";',
  'import { t } from "elysia";',
  'export const route = defineRoute("/[...rest]")',
  '  .config({ mode: "ssr", params: t.Object({ "*": t.String() }) })',
  '  .loader(({ params }) => params["*"] === "missing" ? notFound({ message: "Missing page" }) : {})',
  "  .page(() => <main>Catch-all page</main>);",
].join("\n");
const MOUNTED_SERVER = [
  'import { furin } from "@teyik0/furin";',
  'import { Elysia } from "elysia";',
  "const app = new Elysia()",
  '  .use(new Elysia({ prefix: "/api" }).mount((request) => new Response("auth:" + new URL(request.url).pathname)))',
  '  .use(await furin({ pagesDir: import.meta.dir + "/pages" }));',
  "export default app;",
].join("\n");

function rememberTmpApp(app: TmpApp): TmpApp {
  tmpApps.push(app);
  return app;
}

async function createTestApp(options: FurinOptions): Promise<AnyElysia> {
  return new Elysia().use(await furin(options));
}

async function resetState(): Promise<void> {
  __setDevMode(true);
  __resetTemplateState();
  __resetCompileContext();
  process.chdir(originalCwd);
  process.argv.length = 0;
  process.argv.push(...originalArgv);
  while (tmpApps.length > 0) {
    const app = tmpApps.at(-1);
    if (!app) {
      break;
    }
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        app.cleanup();
        tmpApps.pop();
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 19) {
          throw error;
        }
        // biome-ignore lint/performance/noAwaitInLoops: Windows can release compiled binaries after process exit.
        await Bun.sleep(100);
      }
    }
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

test.serial("furin() runs inherited private data in an SSR child loader", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    [
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
      'export const route = defineRootRoute().config({ mode: "ssr" })',
      '  .requestLoader(() => ({ session: "private" }))',
      "  .layout(({ children }) => <html><head><HeadContent /></head><body>{children}<Scripts /></body></html>);",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'export const route = defineRoute("/").config({ mode: "ssr" })',
      "  .loader(async ({ session }) => ({ message: await session }))",
      "  .page(({ message }) => <main>{message}</main>);",
    ].join("\n")
  );
  process.chdir(app.path);
  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });
  const response = await instance.handle(new Request("http://furin/"));
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<main>private</main>");
});

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

test.serial("furin() rejects one pages directory mounted under two prefixes", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);
  const pagesDir = join(app.path, "src/pages");
  const parent = new Elysia().use(await furin({ pagesDir }));
  const admin = await furin({ pagesDir, prefix: "/admin" });

  expect(() => parent.use(admin)).toThrow(
    `[furin] pagesDir "${pagesDir.replaceAll("\\", "/")}" is mounted under both prefix "/" and prefix "/admin". Route ids carry their mount's prefix, so one pages directory serves one mount: give each mount its own pages directory.`
  );
});

test.serial("each furin() instance purges its own physical paths", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);
  const pagesDir = join(app.path, "src/pages");
  const purged: { admin: string[][]; front: string[][] } = { admin: [], front: [] };

  new Elysia()
    .use(
      await furin({
        cachePurger: (paths) => {
          purged.front.push(paths);
          return Promise.resolve();
        },
        pagesDir,
      })
    )
    .use(
      await furin({
        cachePurger: (paths) => {
          purged.admin.push(paths);
          return Promise.resolve();
        },
        pagesDir: copyPagesForPrefix(app.path, "src/admin", "/admin"),
        prefix: "/admin",
      })
    );
  await revalidatePath("/x", "page");
  await Bun.sleep(0);

  expect(purged).toEqual({ admin: [["/admin/x"]], front: [["/x"]] });
});

test.serial("each furin() instance purges tags through its own tag purger", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);
  const pagesDir = join(app.path, "src/pages");
  const purged: { admin: string[][]; front: string[][] } = { admin: [], front: [] };

  new Elysia()
    .use(
      await furin({
        cacheTagPurger: (tags) => {
          purged.front.push(tags);
          return Promise.resolve();
        },
        pagesDir,
      })
    )
    .use(
      await furin({
        cacheTagPurger: (tags) => {
          purged.admin.push(tags);
          return Promise.resolve();
        },
        pagesDir: copyPagesForPrefix(app.path, "src/admin", "/admin"),
        prefix: "/admin",
      })
    );
  await revalidateTag("posts");
  await Bun.sleep(0);

  expect(purged).toEqual({ admin: [["posts"]], front: [["posts"]] });
});

test.serial("furin() instances sharing a tag purger purge each tag once", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);
  const pagesDir = join(app.path, "src/pages");
  const purged: string[][] = [];
  const cacheTagPurger = (tags: string[]) => {
    purged.push(tags);
    return Promise.resolve();
  };

  new Elysia().use(await furin({ cacheTagPurger, pagesDir })).use(
    await furin({
      cacheTagPurger,
      pagesDir: copyPagesForPrefix(app.path, "src/admin", "/admin"),
      prefix: "/admin",
    })
  );
  await revalidateTag(["posts", "authors"]);
  await Bun.sleep(0);

  expect(purged).toEqual([["posts", "authors"]]);
});

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
  expect(readFileSync(indexPath, "utf8")).toContain('defineRoute("/")\n  .config({ mode: "ssg" })');
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
    await waitForHttp(`http://127.0.0.1:${instance.server?.port}/?_furin=data`, {
      timeoutMs: 3000,
    });
    writeAppFile(
      app.path,
      "src/pages/settings.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'export const route = defineRoute("/settings")',
        '  .config({ mode: "ssg" })',
        "  .page(() => <main>Settings</main>);",
      ].join("\n")
    );

    await waitForFileContent(typesPath, '"/settings": typeof import("./src/pages/settings").route');
  } finally {
    await instance.stop();
  }
});

test.serial("a failed route import keeps its tags while healthy route types update", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  const typesPath = join(app.path, "furin-env.d.ts");
  const taggedRoute = (id: string, tag: string): string =>
    [
      'import { defineRoute } from "@teyik0/furin";',
      `export const route = defineRoute("${id}")`,
      `  .config({ mode: "ssr", tags: ["${tag}"] })`,
      "  .page(() => <main>Tagged</main>);",
    ].join("\n");
  writeAppFile(app.path, "src/pages/fragile.tsx", taggedRoute("/fragile", "fragile"));
  writeAppFile(app.path, "src/pages/healthy.tsx", taggedRoute("/healthy", "before"));
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  instance.listen(0);
  try {
    await waitForHttp(`http://127.0.0.1:${instance.server?.port}/?_furin=data`, {
      timeoutMs: 3000,
    });
    await waitForFileContent(typesPath, "fragile: 'fragile';");
    writeAppFile(app.path, "src/pages/fragile.tsx", 'throw new Error("broken route");');
    writeAppFile(app.path, "src/pages/healthy.tsx", taggedRoute("/healthy", "after"));

    await waitForFileContent(typesPath, "after: 'after';");
    const generated = readFileSync(typesPath, "utf8");
    expect(generated).toContain("fragile: 'fragile';");
    expect(generated).not.toContain("before: 'before';");

    writeAppFile(app.path, "src/pages/healthy.tsx", taggedRoute("/healthy", "latest"));
    await waitForFileContent(typesPath, "latest: 'latest';");
    expect(readFileSync(typesPath, "utf8")).toContain("fragile: 'fragile';");
  } finally {
    await instance.stop();
  }
});

test.serial("furin() serves data requests from the watcher-managed route snapshot", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  const importCountKey = `__furin_route_imports_${Date.now()}`;
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      `const importCountKey = ${JSON.stringify(importCountKey)};`,
      "const testGlobal = globalThis as typeof globalThis & { [key: string]: unknown };",
      "testGlobal[importCountKey] = Number(testGlobal[importCountKey] ?? 0) + 1;",
      'export const route = defineRoute("/")',
      '  .config({ mode: "ssr" })',
      "  .loader(() => ({ title: 'Snapshot route' }))",
      "  .page(({ title }) => <main>{title}</main>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  const importsAfterBoot = Number(
    (globalThis as typeof globalThis & { [key: string]: unknown })[importCountKey]
  );

  const first = await instance.handle(new Request("http://furin/?_furin=data"));
  const second = await instance.handle(new Request("http://furin/?_furin=data"));

  expect(first.status).toBe(200);
  expect(second.status).toBe(200);
  expect(
    Number((globalThis as typeof globalThis & { [key: string]: unknown })[importCountKey])
  ).toBe(importsAfterBoot);
});

test.serial(
  "SPA data runs the parent Elysia guard for the logical page before loaders",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const pagesDir = join(app.path, "src/pages");
    const loaderRunsKey = `__furin_guard_loader_runs_${Date.now()}`;
    writeAppFile(
      app.path,
      "src/pages/secret.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        `const loaderRunsKey = ${JSON.stringify(loaderRunsKey)};`,
        "const testGlobal = globalThis as typeof globalThis & { [key: string]: unknown };",
        'export const route = defineRoute("/secret")',
        '  .config({ mode: "ssr", query: t.Object({ page: t.Number() }) })',
        "  .loader(({ path, query, redirect }) => {",
        "    testGlobal[loaderRunsKey] = Number(testGlobal[loaderRunsKey] ?? 0) + 1;",
        '    if (query.page === 3) throw redirect("/admin/login", 302);',
        '    return { secret: "protected", page: query.page, logicalPath: path };',
        "  })",
        "  .page(({ secret }) => <main>{secret}</main>);",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/login.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'export const route = defineRoute("/login")',
        '  .config({ mode: "ssr" })',
        "  .page(() => <main>Login</main>);",
      ].join("\n")
    );
    keyPagesForPrefix(app.path, "src/pages", "/admin");
    __setDevMode(true);
    process.chdir(app.path);

    const instance = new Elysia()
      .macro({
        adminArea: {
          beforeHandle: ({ path, redirect, request }) => {
            if (path !== "/admin/login" && request.headers.get("x-test-user") !== "admin") {
              return redirect("/admin/login#section", 302);
            }
          },
        },
      })
      .guard({ adminArea: true })
      .use(await furin({ pagesDir, prefix: "/admin" }));

    const denied = await instance.handle(new Request("http://furin/admin/secret?_furin=data"));
    expect(denied.status).toBe(200);
    expect(denied.headers.get("content-type")).toContain("application/x-ndjson");
    expect(denied.headers.get("location")).toBeNull();
    const deniedBody = await denied.text();
    expect(deniedBody).toContain('"__furinRedirect"');
    expect(deniedBody).toContain('"/login#section"');
    expect(
      (globalThis as typeof globalThis & { [key: string]: unknown })[loaderRunsKey]
    ).toBeUndefined();

    const deniedDocument = await instance.handle(new Request("http://furin/admin/secret"));
    expect(deniedDocument.status).toBe(302);
    expect(deniedDocument.headers.get("location")).toBe("/admin/login#section");

    const login = await instance.handle(new Request("http://furin/admin/login?_furin=data"));
    expect(login.status).toBe(200);
    expect(login.headers.get("content-type")).toContain("application/x-ndjson");

    const allowed = await instance.handle(
      new Request("http://furin/admin/secret?page=2&_furin=data", {
        headers: { "x-test-user": "admin" },
      })
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("content-type")).toContain("application/x-ndjson");
    const allowedBody = await allowed.text();
    expect(allowedBody).toContain('"page":2');
    expect(allowedBody).toContain('"logicalPath":"/secret"');
    const redirected = await instance.handle(
      new Request("http://furin/admin/secret?page=3&_furin=data", {
        headers: { "x-test-user": "admin" },
      })
    );
    expect(await redirected.text()).toContain("__furinRedirect");
    expect((globalThis as typeof globalThis & { [key: string]: unknown })[loaderRunsKey]).toBe(2);
  }
);

test.serial("page authorization leaves public assets accessible", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  writeAppFile(app.path, "public/logo.txt", "logo");
  keyPagesForPrefix(app.path, "src/pages", "/admin");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = new Elysia()
    .macro({
      protectedPage: {
        beforeHandle: ({ request, status }) =>
          isFurinPageRequest(request, "/admin") ? status(401) : undefined,
      },
    })
    .guard({ protectedPage: true })
    .post("/admin/", () => "mutation")
    .use(await furin({ pagesDir: join(app.path, "src/pages"), prefix: "/admin" }));

  const document = await instance.handle(new Request("http://furin/admin/"));
  expect(document.status).toBe(401);

  expect(isFurinPageRequest(new Request("http://furin/admin?_furin=data"), "/admin")).toBe(true);
  expect(isFurinPageRequest(new Request("http://furin/admin/", { method: "POST" }), "/admin")).toBe(
    false
  );
  const mutation = await instance.handle(new Request("http://furin/admin/", { method: "POST" }));
  expect(mutation.status).toBe(200);
  expect(await mutation.text()).toBe("mutation");

  const navigation = await instance.handle(new Request("http://furin/admin?_furin=data"));
  expect(navigation.status).toBe(401);

  const asset = await instance.handle(new Request("http://furin/admin/public/logo.txt"));
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe("logo");
});

test.serial("SPA data for an API path is answered by that route, never a page", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);

  const instance = new Elysia()
    .get("/api/private", ({ request }) => ({ url: request.url }))
    .use(await furin({ pagesDir: join(app.path, "src/pages") }));

  const response = await instance.handle(new Request("http://furin/api/private?_furin=data"));
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual({ url: "http://furin/api/private" });
});

test.serial("dev navigation data reports a page module that fails to import", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  __setDevMode(true);
  process.chdir(app.path);
  const instance = await createTestApp({ pagesDir });
  const ready = await instance.handle(new Request("http://furin/?_furin=data"));
  expect(ready.status).toBe(200);

  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    'throw new Error("page import failed");\nexport const route = undefined;\n'
  );
  const response = await instance.handle(new Request("http://furin/?_furin=data"));

  expect(response.status).toBe(500);
  expect(response.headers.get("content-type")).toContain("application/x-ndjson");
  const { syncData } = await parseDeferredNdjson(
    response.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
    undefined
  );
  expect(JSON.stringify(syncData)).toContain('"status":"error"');
});

test.serial("furin() preserves route data while an edited route is invalid", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'export const route = defineRoute("/")',
      '  .config({ mode: "ssr" })',
      "  .loader(() => ({ title: 'Last known good' }))",
      "  .page(({ title }) => <main>{title}</main>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  let instance: Awaited<ReturnType<typeof createTestApp>> | undefined;
  try {
    instance = await createTestApp({ pagesDir });
    instance.listen(0);
    await waitForHttp(`http://127.0.0.1:${instance.server?.port}/?_furin=data`, {
      timeoutMs: 3000,
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
    try {
      // An error.tsx without a default export fails the snapshot refresh.
      writeAppFile(app.path, "src/pages/error.tsx", "export const broken = true;\n");
      const deadline = Date.now() + 3000;
      while (
        !errorSpy.mock.calls.some(
          ([message]) => message === "[furin] Failed to refresh route topology"
        )
      ) {
        if (Date.now() >= deadline) {
          throw new Error("Timed out waiting for the invalid route refresh");
        }
        // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for the topology watcher
        await Bun.sleep(20);
      }

      const response = await instance.handle(new Request("http://furin/?_furin=data"));
      const { syncData } = await parseDeferredNdjson(
        response.body ??
          new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        undefined
      );

      expect(response.status).toBe(200);
      expect(syncData.title).toBe("Last known good");
    } finally {
      errorSpy.mockRestore();
    }
  } finally {
    await instance?.stop();
  }
});

test.serial("furin() reports a removed route id without rewriting the file", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  const routePath = join(pagesDir, "index.tsx");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  instance.listen(0);
  await waitForHttp(`http://127.0.0.1:${instance.server?.port}/?_furin=data`, {
    timeoutMs: 3000,
  });
  const errorSpy = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const source = readFileSync(routePath, "utf8").replace('defineRoute("/")', "defineRoute()");
    writeAppFile(app.path, "src/pages/index.tsx", source);

    const deadline = Date.now() + 3000;
    while (
      !errorSpy.mock.calls.some(([message]) =>
        String(message).includes("defineRoute() must name this file")
      )
    ) {
      if (Date.now() >= deadline) {
        throw new Error("Timed out waiting for the route config diagnostic");
      }
      // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for the topology watcher
      await Bun.sleep(20);
    }
    expect(readFileSync(routePath, "utf8")).toBe(source);
  } finally {
    errorSpy.mockRestore();
    await instance.stop();
  }
});

test.serial("furin() registers native routes in dev without replacing SSR responses", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'export const route = defineRoute("/")',
      '  .config({ mode: "ssr" })',
      "  .loader(() => ({ title: 'Native route' }))",
      "  .page(({ title }) => <main>{title}</main>);",
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

  expect(nativeResponse.status).toBe(500);
  expect(await nativeResponse.text()).not.toContain("Native route");
  expect(ssrResponse.headers.get("content-type")).toContain("text/html");
  expect(await ssrResponse.text()).toContain("Native route");
});

test.serial("furin() lets a prefixed mount handle GET before a root catch-all page", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(app.path, "src/pages/[...rest].tsx", ROOT_CATCH_ALL_PAGE);
  __setDevMode(true);
  process.chdir(app.path);

  const instance = new Elysia()
    .use(
      new Elysia({ prefix: "/api" }).mount(
        (request) => new Response(`auth:${new URL(request.url).pathname}`)
      )
    )
    .use(await furin({ pagesDir }));
  const response = await instance.handle(new Request("http://furin/api/auth/session"));
  const pageResponse = await instance.handle(new Request("http://furin/some-page"));
  const nativeModule = (await import(routeModuleSpecifier({ pagesDir, prefix: "" }))) as {
    furinApp: { handle: (request: Request) => Promise<Response> };
  };
  const standaloneResponse = await nativeModule.furinApp.handle(
    new Request("http://furin/some-page")
  );

  expect(response.status).toBe(200);
  expect(await response.text()).toBe("auth:/auth/session");
  expect(pageResponse.status).toBe(200);
  expect(await pageResponse.text()).toContain("Catch-all page");
  expect(standaloneResponse.status).toBe(500);
});

test.serial("furin() keeps a prefixed catch-all page behind a mounted handler", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(app.path, "src/pages/[...rest].tsx", ROOT_CATCH_ALL_PAGE);
  keyPagesForPrefix(app.path, "src/pages", "/site");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = new Elysia()
    .use(
      new Elysia({ prefix: "/api" }).mount(
        (request) => new Response(`auth:${new URL(request.url).pathname}`)
      )
    )
    .use(await furin({ pagesDir, prefix: "/site" }));
  const apiResponse = await instance.handle(new Request("http://furin/api/auth/session"));
  const pageResponse = await instance.handle(new Request("http://furin/site/some-page"));

  expect(await apiResponse.text()).toBe("auth:/auth/session");
  expect(pageResponse.status).toBe(200);
  expect(await pageResponse.text()).toContain("Catch-all page");
});

test.serial(
  "furin() built catch-all page coexists with a prefixed mount",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "src/pages/[...rest].tsx", ROOT_CATCH_ALL_PAGE);
    writeAppFile(app.path, "src/server.ts", MOUNTED_SERVER);

    const result = await runCli(["build", "--target", "bun"], { cwd: app.path });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    const port = await getFreePort();
    const server = startProcess([process.execPath, join(app.path, ".furin/build/bun/server.js")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    try {
      const apiResponse = await waitForHttp(`http://127.0.0.1:${port}/api/auth/session`, {
        timeoutMs: 10_000,
      });
      const pageResponse = await fetch(`http://127.0.0.1:${port}/some-page`);
      const missingResponse = await fetch(`http://127.0.0.1:${port}/missing`);

      expect(pageResponse.status).toBe(200);
      expect(await pageResponse.text()).toContain("Catch-all page");
      expect(apiResponse.status).toBe(200);
      expect(await apiResponse.text()).toBe("auth:/auth/session");
      expect(missingResponse.status).toBe(404);
    } finally {
      server.kill();
      await server.exitCode;
    }
  },
  30_000
);

test.serial(
  "furin() compiled server serves a prefixed mount and a catch-all page",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    writeAppFile(app.path, "src/pages/[...rest].tsx", ROOT_CATCH_ALL_PAGE);
    writeAppFile(app.path, "src/server.ts", MOUNTED_SERVER);

    const result = await runCli(["build", "--target", "bun", "--compile", "server"], {
      cwd: app.path,
    });
    if (result.exitCode !== 0) {
      throw new Error(result.stderr || result.stdout);
    }
    const port = await getFreePort();
    const serverFilename = process.platform === "win32" ? "server.exe" : "server";
    const server = startProcess([join(app.path, ".furin/build/bun", serverFilename)], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    try {
      const authResponse = await waitForHttp(`http://127.0.0.1:${port}/api/auth/session`, {
        timeoutMs: 10_000,
      });
      const pageResponse = await fetch(`http://127.0.0.1:${port}/some-page`);
      expect(await authResponse.text()).toBe("auth:/auth/session");
      const pageHtml = await pageResponse.text();
      expect(pageResponse.status, `${pageHtml}\n${server.getStdout()}\n${server.getStderr()}`).toBe(
        200
      );
      expect(pageHtml).toContain("Catch-all page");
    } finally {
      server.kill();
      await server.exitCode;
    }
  },
  30_000
);

test.serial(
  "dev HTTP routes validate current params schemas before SSR and navigation loaders",
  async () => {
    const app = rememberTmpApp(createTmpApp("cli-app"));
    const pagePath = "src/pages/items/[id].tsx";
    const pageSource = (version: "after" | "before") =>
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        'export const route = defineRoute("/items/[id]")',
        `  .config({ ${version === "before" ? 'mode: "ssr"' : 'mode: "isr", revalidate: 60'},`,
        `    params: t.Object({ id: t.${version === "before" ? "Number" : "String"}() }),`,
        `    query: t.Object({ page: t.${version === "before" ? "Number" : "String"}() }) })`,
        `  .loader(({ params, query }) => ({ summary: "${version}:" + typeof params.id + ":" + typeof query.page, id: params.id }))`,
        "  .page(({ summary, id }) => <main>{summary}:{id}</main>);",
      ].join("\n");
    writeAppFile(app.path, pagePath, pageSource("before"));
    const port = await getFreePort();
    const server = startProcess([process.execPath, "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    const origin = `http://127.0.0.1:${port}`;
    const navigationPath = (path: string) => `${path}&_furin=data`;
    try {
      const ready = await waitForHttp(`${origin}/_bun_hmr_entry`, { timeoutMs: 10_000 });
      await ready.arrayBuffer();
      await Promise.all(
        ["/items/42?page=1", navigationPath("/items/42?page=1")].map(async (path) => {
          const response = await fetch(origin + path);
          const body = await response.text();
          expect(response.status, `${body}\n${server.getStderr()}`).toBe(200);
          expect(body).toContain("before:number:number");
        })
      );
      await Promise.all(
        ["/items/invalid?page=1", navigationPath("/items/invalid?page=1")].map(async (path) => {
          const response = await fetch(origin + path);
          await response.arrayBuffer();
          expect(response.status).toBe(422);
        })
      );
      writeAppFile(app.path, pagePath, pageSource("after"));
      const deadline = Date.now() + 4000;
      let body = "";
      do {
        // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for the route schema watcher.
        const response = await fetch(origin + navigationPath("/items/42?page=1"));
        body = await response.text();
        if (body.includes("after:string:string")) {
          break;
        }
        await Bun.sleep(20);
      } while (Date.now() < deadline);
      expect(body, server.getStderr()).toContain("after:string:string");
      await Promise.all(
        ["/items/a%2Fb?page=1", navigationPath("/items/a%2Fb?page=1")].map(async (path) => {
          const response = await fetch(origin + path);
          const result = await response.text();
          expect(response.status, result).toBe(200);
          expect(result).toContain("after:string:string");
          expect(result).toContain("a/b");
        })
      );
    } finally {
      server.kill();
      await server.exitCode;
    }
  },
  30_000
);

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
        'export const route = defineRoute("/boards/_route")',
        '  .config({ mode: "ssr", query: t.Object({ locale: t.String() }) })',
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
        'export const route = defineRoute("/boards/[id]")',
        '  .config({ mode: "ssr", params: t.Object({ id: t.Number() }) })',
        "  .loader(async (context) => {",
        "    const parent = context as typeof context & { organization: Promise<string> | string; query: { locale: string } };",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: source fixture contains a template literal
        "    return { label: `${await parent.organization}:${context.params.id}:${parent.query.locale}` };",
        "  })",
        "  .page(({ label }) => <main>{label}</main>);",
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
      'export const route = defineRoute("/")',
      '  .config({ mode: "ssr" })',
      "  .loader(() => defer({ slow: Promise.resolve('later'), title: 'Native deferred' }))",
      "  .page(({ title }) => <main>{title}</main>);",
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

test.serial("furin() dev serves public files before the application 404", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(app.path, "public/health.txt", "public-health");
  writeAppFile(app.path, "public/favicon.ico", "favicon");
  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    [
      'import { defineRootRoute } from "@teyik0/furin";',
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssr" })',
      '  .loader(() => { throw new Error("404 must not run root loaders"); })',
      "  .layout(({ children }) => <html><body>{children}</body></html>);",
    ].join("\n")
  );
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir });
  const publicResponse = await instance.handle(new Request("http://furin/public/health.txt"));
  const faviconResponse = await instance.handle(new Request("http://furin/favicon.ico"));
  const notFoundResponse = await instance.handle(new Request("http://furin/unknown"));

  expect(publicResponse.status).toBe(200);
  expect(await publicResponse.text()).toBe("public-health");
  expect(faviconResponse.status).toBe(200);
  expect(await faviconResponse.text()).toBe("favicon");
  expect(notFoundResponse.status).toBe(404);
  expect(await notFoundResponse.text()).toContain("404 — NOT FOUND");
});

test.serial("furin() dev serves public files and 404s under a prefix", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  const pagesDir = join(app.path, "src/pages");
  writeAppFile(app.path, "public/health.txt", "admin-public-health");
  keyPagesForPrefix(app.path, "src/pages", "/admin");
  __setDevMode(true);
  process.chdir(app.path);

  const instance = await createTestApp({ pagesDir, prefix: "/admin" });
  const publicResponse = await instance.handle(new Request("http://furin/admin/public/health.txt"));
  const notFoundResponse = await instance.handle(new Request("http://furin/admin/unknown"));

  expect(publicResponse.status).toBe(200);
  expect(await publicResponse.text()).toBe("admin-public-health");
  expect(notFoundResponse.status).toBe(404);
});

test.serial("furin() excludes internal DevTools requests from logging", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(true);
  process.chdir(app.path);

  const capture = captureEvlogEvents();
  const instance = await createTestApp({
    logger: { drain: capture.drain },
    pagesDir: join(app.path, "src/pages"),
  });

  const devtools = await instance.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  await devtools.text();
  const event = capture.next();
  const page = await instance.handle(new Request("http://localhost/"));
  await page.text();

  expect(devtools.status).toBe(200);
  expect(await event).toMatchObject({ path: "/" });
  expect(capture.events.map((logged) => logged.path)).toEqual(["/"]);
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
    new Request("http://localhost/_furin/devtools/snapshot")
  );
  const clientResponse = await instance.handle(
    new Request("http://furin/_furin/devtools/client.js")
  );
  const removedEventsResponse = await instance.handle(
    new Request("http://furin/_furin/devtools/events")
  );

  expect(htmlResponse.status).toBe(200);
  expect(await htmlResponse.text()).not.toContain("furin-devtools");
  expect(snapshotResponse.status).toBe(404);
  expect(clientResponse.status).toBe(404);
  expect(removedEventsResponse.status).toBe(404);

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
        'export const route = defineRoute("/")',
        '  .config({ mode: "ssr" })',
        "  .loader(() => ({ title: 'Compiled native' }))",
        "  .page(({ title }) => <main>{title}</main>);",
      ].join("\n")
    );
    __setDevMode(false);
    process.chdir(app.path);

    const context = await createBuiltRouteContext(app.path);
    const clientDir = join(app.path, "native-client");
    mkdirSync(clientDir, { recursive: true });
    const templatePath = join(clientDir, "index.html");
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
      embedded: { clientDir },
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

const platformCapabilities = {
  assets: "platform",
  publicCache: "platform",
  websocket: false,
} as const;

test.serial("furin() rejects a custom page cache when the platform caches pages", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  __setCompileContext({
    ...(await createBuiltRouteContext(app.path)),
    adapter: { capabilities: platformCapabilities, name: "edge-cdn" },
  });

  await expect(
    createTestApp({
      pageCache: createMemoryPageCache(),
      pagesDir: join(app.path, "src/pages"),
    })
  ).rejects.toThrow(
    '[furin] pageCache cannot be configured with the "edge-cdn" adapter: its platform caches public SSG, ISR, and PPR pages.'
  );
});

test.serial("furin() leaves assets to a platform that serves them", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);
  const clientDir = join(app.path, "client");
  mkdirSync(clientDir);
  writeFileSync(join(clientDir, "app.js"), "console.log('client');");

  __setCompileContext({
    ...(await createBuiltRouteContext(app.path)),
    adapter: { capabilities: platformCapabilities, name: "edge-cdn" },
    clientDir,
    templateHtml: "<html><head></head><body><!--ssr-outlet--></body></html>",
  });

  const instance = await createTestApp({ pagesDir: join(app.path, "src/pages") });
  const asset = await instance.handle(new Request("http://furin/_client/app.js"));

  expect(asset.status).toBe(404);
});

test.serial("furin() streams browser events over SSE without WebSocket support", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  __setDevMode(false);
  process.chdir(app.path);

  __setCompileContext({
    ...(await createBuiltRouteContext(app.path)),
    adapter: { capabilities: platformCapabilities, name: "edge-cdn" },
    templateHtml: "<html><head></head><body><!--ssr-outlet--></body></html>",
  });

  const instance = await createTestApp({
    pagesDir: join(app.path, "src/pages"),
    sync: {
      adapter: {
        abortMutation: async () => undefined,
        appendInvalidations: () => Promise.resolve("0"),
        beginMutation: async () => ({ kind: "conflict", reason: "in-progress" }),
        completeMutation: async () => ({ kind: "lost" }),
        currentCursor: async () => "7",
        readChanges: async () => ({ changes: [], cursor: "7", hasMore: false, reset: false }),
        renewMutation: async () => "lost",
        scope: "host-local",
      },
      principal: () => "test",
    },
  });
  const client = await instance.handle(new Request("http://furin/_furin/events/client.js"));

  expect(await client.text()).toContain("EventSource");
});

test.serial("furin() rejects dev pages without a root layout", async () => {
  const app = rememberTmpApp(createTmpApp("cli-app"));
  removeAppPath(app.path, "src/pages/root.tsx");
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "furin";',
      "export const route = defineRoute(\"/\").config({ mode: 'ssg' })",
      "  .page(() => <main>No root</main>);",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    [
      'import { defineRoute } from "furin";',
      'import { t } from "elysia";',
      "export const route = defineRoute(\"/blog/[slug]\").config({ mode: 'ssg',",
      "  params: t.Object({ slug: t.String() }),",
      "}).staticParams(() => [{ slug: 'hello-world' }])",
      "  .page(() => <article>No root blog</article>);",
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
