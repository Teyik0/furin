import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "../../../src/build/index.ts";
import { ssgRouteCache } from "../../../src/server/cache/ssg.ts";
import { __resetTemplateState } from "../../../src/server/render/template.ts";
import { createTmpApp, type TmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const tmpApps: TmpApp[] = [];

function createVercelApp(): TmpApp {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(
    app.path,
    "src/server.ts",
    [
      'import { furin, revalidatePath, revalidateTag } from "@teyik0/furin";',
      'import { Elysia } from "elysia";',
      'import { userHydrate } from "./build/hydrate";',
      "",
      "const app = new Elysia()",
      '  .get("/api/health", () => userHydrate)',
      '  .post("/api/revalidate", () => {',
      '    revalidatePath("/", "page");',
      '    return "invalidated";',
      "  })",
      '  .post("/api/revalidate-tag", () => {',
      '    revalidateTag("news,world");',
      '    return "tag invalidated";',
      "  })",
      '  .use(await furin({ pagesDir: "./src/pages" }));',
      "",
      "if (import.meta.main) {",
      "  app.listen(3000);",
      "}",
      "",
      "export default app;",
      "",
    ].join("\n")
  );
  writeAppFile(app.path, "src/build/hydrate.ts", 'export const userHydrate = "user hydrate";\n');
  writeAppFile(app.path, "public/user.txt", "user static asset");
  writeAppFile(
    app.path,
    "src/pages/news.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "isr", revalidate: 90, tags: ["news,world"] })',
      "  .page(() => <main>News</main>);",
      "",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/search.tsx",
    [
      'import { t } from "elysia";',
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "isr", query: t.Object({ q: t.Optional(t.String()) }), revalidate: 90 })',
      '  .loader(({ query }) => ({ q: query.q }))',
      '  .page(({ data }) => <main>Search: {data.q}</main>);',
      "",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/events/[slug].tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { t } from "elysia";',
      'import { route as rootRoute } from "../root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "isr", params: t.Object({ slug: t.String() }), revalidate: 90, staticParams: () => [{ slug: "launch" }] })',
      '  .page(({ params }) => <main>Event: {params.slug}</main>);',
      "",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/offers.tsx",
    [
      'import { t } from "elysia";',
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg", query: t.Object({ coupon: t.Optional(t.String()) }) })',
      '  .page(({ query }) => <main>Coupon: {query.coupon}</main>);',
      "",
    ].join("\n")
  );
  return app;
}

function cleanupTmpApps(): void {
  ssgRouteCache().clear();
  __resetTemplateState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

process.on("exit", cleanupTmpApps);

describe.serial("Vercel deployment adapter", () => {
  test("emits CDN assets, a Bun catch-all function, and native SSG/ISR prerenders", (done) => {
    async function runScenario(): Promise<void> {
      const app = createVercelApp();
      writeAppFile(app.path, "public/_client/_hydrate.js", "public collision");
      const buildConfigs: Bun.BuildConfig[] = [];

      const result = await withBuildStub(
        () =>
          buildApp({
            analyze: true,
            rootDir: app.path,
            target: "vercel",
            vercelConfig: { regions: ["cdg1"] },
          }),
        (config) => {
          buildConfigs.push(config);
        }
      );

      const outputDir = join(app.path, ".vercel/output");
      const functionsDir = join(outputDir, "functions");
      const serverFunctionDir = join(functionsDir, "__server.func");
      const config = JSON.parse(readFileSync(join(outputDir, "config.json"), "utf8"));
      const functionConfig = JSON.parse(
        readFileSync(join(serverFunctionDir, ".vc-config.json"), "utf8")
      );
      const bootstrap = readFileSync(join(serverFunctionDir, "index.js"), "utf8");

      expect(config.version).toBe(3);
      expect(config.framework).toEqual({ name: "furin", version: "0.4.0-alpha.2" });
      expect(config.routes).toContainEqual({ handle: "filesystem" });
      expect(config.routes).toContainEqual({
        dest: "/news-isr?__furin_path=$__furin_path",
        src: "(?<__furin_path>/news)",
      });
      expect(config.routes).toContainEqual({
        dest: "/blog/hello-world-ssg?__furin_path=$__furin_path",
        src: "(?<__furin_path>/blog/hello-world)",
      });
      expect(config.routes).toContainEqual({
        dest: "/blog/[slug]-ssg?__furin_path=$__furin_path",
        src: "(?<__furin_path>/blog/[^/]+)",
      });
      expect(config.routes.at(-1)).toEqual({ dest: "/__server", src: "/(.*)" });

      expect(functionConfig).toEqual({
        handler: "index.js",
        launcherType: "Nodejs",
        runtime: "bun1.4.x",
        regions: ["cdg1"],
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
      });
      expect(bootstrap).toContain('import("./handler.js")');
      expect(bootstrap).toContain("furin_module_init");
      expect(bootstrap).toContain("furin_server_init");
      expect(bootstrap).toContain('event: "vercel_cold_start"');
      expect(
        existsSync(join(app.path, ".furin/build/analysis/vercel-server.json"))
      ).toBe(true);
      expect(existsSync(join(outputDir, "static/_client/_hydrate.js"))).toBe(true);
      expect(readFileSync(join(outputDir, "static/_client/_hydrate.js"), "utf8")).not.toBe(
        "public collision"
      );
      expect(existsSync(join(outputDir, "static/.gitkeep"))).toBe(true);
      expect(lstatSync(join(functionsDir, "news-isr.func")).isSymbolicLink()).toBe(true);
      const newsPrerender = JSON.parse(
        readFileSync(join(functionsDir, "news-isr.prerender-config.json"), "utf8")
      );
      expect(newsPrerender.expiration).toBe(90);
      expect(newsPrerender.fallback).toBe("news-isr.prerender-fallback.html");
      expect(newsPrerender.initialHeaders["vercel-cache-tag"]).toBe("/news,news%2Cworld");
      expect(readFileSync(join(functionsDir, newsPrerender.fallback), "utf8")).toContain("News");
      const searchPrerender = JSON.parse(
        readFileSync(join(functionsDir, "search-isr.prerender-config.json"), "utf8")
      );
      expect(searchPrerender.fallback).toBeUndefined();
      const offersPrerender = JSON.parse(
        readFileSync(join(functionsDir, "offers-ssg.prerender-config.json"), "utf8")
      );
      expect(offersPrerender.fallback).toBeUndefined();
      const eventPrerender = JSON.parse(
        readFileSync(join(functionsDir, "events/launch-isr.prerender-config.json"), "utf8")
      );
      expect(eventPrerender.expiration).toBe(90);
      expect(eventPrerender.fallback).toBe("launch-isr.prerender-fallback.html");
      expect(
        JSON.parse(
          readFileSync(
            join(functionsDir, "blog/hello-world-ssg.prerender-config.json"),
            "utf8"
          )
        ).fallback
      ).toBe("hello-world-ssg.prerender-fallback.html");
      expect(
        readFileSync(
          join(functionsDir, "blog/hello-world-ssg.prerender-fallback.html"),
          "utf8"
        )
      ).toContain("Blog post page");

      const rootPrerender = JSON.parse(
        readFileSync(join(functionsDir, "index-ssg.prerender-config.json"), "utf8")
      );
      expect(rootPrerender.expiration).toBe(false);
      expect(rootPrerender.fallback).toBe("index-ssg.prerender-fallback.html");
      expect(rootPrerender.initialHeaders).toEqual({
        "content-type": "text/html; charset=utf-8",
        "vercel-cache-tag": "/",
      });
      expect(readFileSync(join(functionsDir, rootPrerender.fallback), "utf8")).toContain(
        "Home page"
      );

      const serverBuild = buildConfigs.find((build) =>
        build.entrypoints.some((entrypoint) => entrypoint.endsWith("_vercel-handler.ts"))
      );
      const entrypoint = serverBuild?.entrypoints[0] as string;
      const source = serverBuild?.files?.[entrypoint] as string;
      expect(source).toContain("@vercel+functions");
      expect(source).toContain("getCache as getVercelCache");
      expect(source).toContain("invalidateByTag");
      expect(source).toContain("setRuntimeCacheProvider");
      expect(source).toContain("waitUntil");
      expect(source).toContain("serverModule.default");
      expect(source).toContain("app.handle(restoredRequest)");
      expect(source.indexOf("setRuntimeCacheProvider({")).toBeLessThan(
        source.indexOf("const serverModule = await import")
      );

      const manifest = result.targets.vercel;
      if (!manifest || !("isrRoutes" in manifest)) {
        throw new TypeError("Expected the Vercel target manifest");
      }
      expect(manifest.isrRoutes).toEqual(["/events/:slug", "/news", "/search"]);
      expect(manifest.outputDir).toBe(".vercel/output");
      expect(manifest.ssgRoutes).toEqual(["/", "/blog/hello-world"]);
    }

    runScenario().then(() => done(), done);
  });

  test("requires the Vercel server entry to export its Elysia app as default", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);

    await expect(
      withBuildStub(() => buildApp({ rootDir: app.path, target: "vercel" }))
    ).rejects.toThrow("must export the Elysia app as default");
  });

  test("rejects application static mounts instead of shipping missing files", async () => {
    const app = createVercelApp();
    const serverPath = join(app.path, "src/server.ts");
    writeAppFile(app.path, "src/server.ts",
      'import { staticPlugin } from "@elysiajs/static";\n' +
      readFileSync(serverPath, "utf8").replace("new Elysia()", 'new Elysia().use(await staticPlugin({ assets: "./public", prefix: "/user-static" }))')
    );
    let failure: unknown;
    try {
      await buildApp({ rootDir: app.path, target: "vercel" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) {
      throw new Error("Expected a failed static mount build");
    }
    expect(failure.errors.map(String).join("\n")).toContain("static mounts");
  });

  test("keeps SSR and personalized routes ahead of generic prerenders", (done) => {
    async function runScenario() {
    const app = createVercelApp();
    for (const [name, mode] of [["private", "ssr"], ["hello-world", "ssr"], ["account", "isr"]] as const) {
      writeAppFile(
        app.path,
        `src/pages/blog/${name}.tsx`,
        `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";
export const route = defineRoute().config({ layout: rootRoute, mode: "${mode}" })
  ${mode === "isr" ? '.requestLoader(({ cookies }) => ({ user: cookies.get("session") }))' : ""}
  .page(() => <main>${name}</main>);`
      );
    }
    await withBuildStub(() => buildApp({ rootDir: app.path, target: "vercel" }));
    const output = join(app.path, ".vercel/output");
    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8")) as {
      routes: { src?: string; dest?: string }[];
    };
    for (const path of ["/blog/private", "/blog/hello-world", "/blog/account"]) {
      const matched = config.routes.find((rule) => rule.src && new RegExp(`^${rule.src}$`).test(path));
      expect(matched?.dest).toBe("/__server");
    }
    expect(existsSync(join(output, "functions/blog/account-isr.prerender-config.json"))).toBe(false);
    }
    runScenario().then(() => done(), done);
  });

  test("keeps prefixed apps and their CDN assets isolated", (done) => {
    async function runScenario(): Promise<void> {
      const app = createVercelApp();
      writeAppFile(
        app.path,
        "src/server.ts",
        [
          'import { furin } from "@teyik0/furin";',
          'import { Elysia } from "elysia";',
          "",
          "const app = new Elysia()",
          '  .use(await furin({ pagesDir: "./src/pages" }))',
          '  .use(await furin({ pagesDir: "./src/pages", prefix: "/admin" }));',
          "",
          "if (import.meta.main) {",
          "  app.listen(3000);",
          "}",
          "",
          "export default app;",
          "",
        ].join("\n")
      );

      await buildApp({
        apps: [
          { pagesDir: "src/pages", prefix: "" },
          { pagesDir: "src/pages", prefix: "/admin" },
        ],
        rootDir: app.path,
        target: "vercel",
      });

      const outputDir = join(app.path, ".vercel/output");
      const config = JSON.parse(readFileSync(join(outputDir, "config.json"), "utf8"));
      expect(existsSync(join(outputDir, "static/_client/index.html"))).toBe(true);
      expect(existsSync(join(outputDir, "static/admin/_client/index.html"))).toBe(true);
      expect(config.routes).toContainEqual({
        dest: "/admin-ssg?__furin_path=$__furin_path",
        src: "(?<__furin_path>/admin)",
      });
      const adminConfig = JSON.parse(
        readFileSync(
          join(outputDir, "functions/admin-ssg.prerender-config.json"),
          "utf8"
        )
      );
      expect(adminConfig.initialHeaders["vercel-cache-tag"]).toBe("/admin");
      expect(
        readFileSync(
          join(outputDir, "functions/admin-ssg.prerender-fallback.html"),
          "utf8"
        )
      ).toContain('src="/admin/_client/');
    }

    runScenario().then(() => done(), done);
  });

  test("runs the generated Web Handler without opening a TCP listener", async () => {
    const app = createVercelApp();
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "",
        "let renderCount = 0;",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssg" })',
        "  .loader(() => ({ renderCount: ++renderCount }))",
        '  .page(({ data }) => <main>SSG render {data.renderCount}</main>);',
        "",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/news.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "",
        "let renderCount = 0;",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "isr", revalidate: 90, tags: ["news,world"] })',
        "  .loader(() => ({ renderCount: ++renderCount }))",
        '  .page(({ data }) => <main>ISR render {data.renderCount}</main>);',
        "",
      ].join("\n")
    );
    writeAppFile(
      app.path,
      "src/pages/flight.tsx",
      `import { defineRoute } from "@teyik0/furin";
import { renderServerComponent } from "@teyik0/furin/rsc";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () => ({ article: await renderServerComponent(<h1>Flight article</h1>) }))
  .page(({ data }) => <main>{data.article}</main>);`
    );
    writeAppFile(
      app.path,
      "src/pages/account.tsx",
      `import { defineRoute } from "@teyik0/furin";
import { Suspense, use } from "react";
import { route as rootRoute } from "./root";
let calls = 0;
function User({ data }: { data: Promise<{ user: string }> }) {
  return <strong>{use(data).user}</strong>;
}
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr", revalidate: 60, tags: ["news,world"] })
  .requestLoader(({ cookies }) => ({ user: cookies.get("session") }))
  .loader(() => ({ count: ++calls }))
  .page(({ data, requestData }) => <main>public:{data.count}<Suspense fallback="loading"><User data={requestData} /></Suspense></main>);`
    );
    await buildApp({ analyze: true, rootDir: app.path, target: "vercel" });

    const handlerPath = join(
      app.path,
      ".vercel/output/functions/__server.func/index.js"
    );
    const serverMetafile = JSON.parse(
      readFileSync(join(app.path, ".furin/build/analysis/vercel-server.json"), "utf8")
    ) as { inputs: { [path: string]: unknown } };
    const serverInputs = Object.keys(serverMetafile.inputs).filter(
      (path) => !path.startsWith("furin-production-runtime-stub:")
    );
    expect(serverInputs.some((path) => path.endsWith("/src/build/hydrate.ts"))).toBe(true);
    expect(
      serverInputs.some((path) => path.endsWith("/plugin/route-config-autofix.ts"))
    ).toBe(false);
    expect(
      serverInputs.some((path) => path.endsWith("/server/dev-page-plugin.ts"))
    ).toBe(false);
    expect(serverInputs.some((path) => path.includes("@elysiajs+static"))).toBe(false);
    const script = `
      const pending = [];
      const purged = [];
      const registeredTags = [];
      const expiredTags = [];
      const cache = new Map();
      globalThis[Symbol.for("@vercel/request-context")] = {
        get: () => ({
          addCacheTag: async (tags) => { registeredTags.push(tags); },
          cache: {
            get: async (key) => cache.get(key)?.value ?? null,
            set: async (key, value, options) => { cache.set(key, { value, tags: options.tags }); },
            expireTag: async (tags) => {
              expiredTags.push(tags);
              for (const [key, entry] of cache) {
                if (entry.tags.some((tag) => tags.includes(tag))) cache.delete(key);
              }
            },
          },
          purge: {
            invalidateByTag: async (tags) => {
              purged.push(tags);
            },
          },
          waitUntil: (promise) => {
            pending.push(promise);
          },
        }),
      };
      const handler = (await import(${JSON.stringify(pathToFileURL(handlerPath).href)})).default;
      const flight = await handler.fetch(new Request("http://furin.test/flight"));
      const flightData = await handler.fetch(new Request("http://furin.test/_furin/data?path=/flight"));
      const api = await handler.fetch(new Request("http://furin.test/api/health"));
      const injected = await handler.fetch(new Request("http://furin.test/api/health?__furin_path=/news"));
      const ssgFirst = await handler.fetch(new Request("http://furin.test/index-ssg?__furin_path=/"));
      const ssgSecond = await handler.fetch(new Request("http://furin.test/index-ssg?__furin_path=/"));
      const offers = await handler.fetch(new Request("http://furin.test/offers-ssg?__furin_path=/offers&coupon=SALE"));
      const data = await handler.fetch(new Request("http://furin.test/_furin/data?path=%2F"));
      const accountFirst = await handler.fetch(new Request("http://furin.test/account", { headers: { cookie: "session=alice" } }));
      const accountFirstBody = await accountFirst.text();
      const accountSecond = await handler.fetch(new Request("http://furin.test/account", { headers: { cookie: "session=bob" } }));
      const accountSecondBody = await accountSecond.text();
      const accountData = await handler.fetch(new Request("http://furin.test/_furin/data?path=/account"));
      const { parseDeferredNdjson } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dir, "../../../src/shared/deferred-ndjson.ts")).href)});
      const accountDataCount = (await parseDeferredNdjson(accountData.body, undefined)).syncData.count;
      const tagInvalidation = await handler.fetch(new Request("http://furin.test/api/revalidate-tag", { method: "POST" }));
      await Promise.all(pending);
      const accountAfterPurge = await handler.fetch(new Request("http://furin.test/account"));
      const accountAfterPurgeBody = await accountAfterPurge.text();
      const isrFirst = await handler.fetch(new Request("http://furin.test/news-isr?__furin_path=/news"));
      const isrSecond = await handler.fetch(new Request("http://furin.test/news-isr?__furin_path=/news"));
      const invalidation = await handler.fetch(new Request("http://furin.test/api/revalidate", { method: "POST" }));
      const pendingCount = pending.length;
      await Promise.all(pending);
      console.log("__FURIN_RESULT__" + JSON.stringify({
        flightStatus: flight.status,
        flightBody: await flight.text(),
        flightDataStatus: flightData.status,
        apiBody: await api.text(),
        apiStatus: api.status,
        dataCacheControl: data.headers.get("cache-control"),
        dataTag: data.headers.get("vercel-cache-tag"),
        injectedBody: await injected.text(),
        invalidationBody: await invalidation.text(),
        isrFirstBody: await isrFirst.text(),
        isrSecondBody: await isrSecond.text(),
        isrTag: isrFirst.headers.get("vercel-cache-tag"),
        pendingCount,
        purged,
        registeredTags,
        expiredTags,
        accountFirstBody,
        accountSecondBody,
        accountAfterPurgeBody,
        accountDataCount,
        accountCacheControl: accountFirst.headers.get("cache-control"),
        accountDataCacheControl: accountData.headers.get("cache-control"),
        ssgFirstBody: await ssgFirst.text(),
        ssgSecondBody: await ssgSecond.text(),
        ssgTag: ssgFirst.headers.get("vercel-cache-tag"),
        offersBody: await offers.text(),
        tagInvalidationBody: await tagInvalidation.text(),
        serverTiming: api.headers.get("server-timing"),
      }));
      process.exit(0);
    `;
    const child = Bun.spawn([process.execPath, "-e", script], {
      cwd: app.path,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    const resultLine = stdout
      .split("\n")
      .find((line) => line.startsWith("__FURIN_RESULT__"));
    if (resultLine === undefined) {
      throw new Error(`Generated handler did not report a result:\n${stdout}`);
    }
    const result = JSON.parse(resultLine.slice("__FURIN_RESULT__".length));
    expect(result.flightStatus).toBe(200);
    expect(result.flightBody).toContain("Flight article");
    expect(result.flightDataStatus).toBe(200);
    expect(result.apiStatus).toBe(200);
    expect(result.apiBody).toBe("user hydrate");
    expect(result.injectedBody).toBe("user hydrate");
    expect(result.dataCacheControl).toBe(
      "public, max-age=0, must-revalidate, s-maxage=31536000"
    );
    expect(result.dataTag).toBe("/");
    expect(result.serverTiming).toContain("furin_module_init;dur=");
    expect(result.serverTiming).toContain("furin_server_init;dur=");
    expect(result.serverTiming).toContain("furin_handler;dur=");
    expect(result.invalidationBody).toBe("invalidated");
    expect(result.pendingCount).toBe(2);
    expect(result.purged).toEqual([["news%2Cworld"], ["/"]]);
    expect(result.registeredTags).toContainEqual(["/news", "news%2Cworld"]);
    expect(result.expiredTags).toEqual([["news,world"], ["/"]]);
    expect(result.accountFirstBody).toContain("alice");
    expect(result.accountSecondBody).toContain("bob");
    expect(result.accountSecondBody).not.toContain("alice");
    expect(result.accountFirstBody).toContain("public:<!-- -->1");
    expect(result.accountSecondBody).toContain("public:<!-- -->1");
    expect(result.accountDataCount).toBe(1);
    expect(result.accountAfterPurgeBody).toContain("public:<!-- -->2");
    expect(result.accountCacheControl).toBe("private, no-store");
    expect(result.accountDataCacheControl).toBe("private, no-store");
    expect(result.ssgTag).toBe("/");
    expect(result.ssgFirstBody).toContain('"renderCount":1');
    expect(result.ssgSecondBody).toContain('"renderCount":2');
    expect(result.offersBody).toContain("SALE");
    expect(result.isrTag).toBe("/news,news%2Cworld");
    expect(result.tagInvalidationBody).toBe("tag invalidated");
    expect(result.isrFirstBody).toContain('"renderCount":1');
    expect(result.isrSecondBody).toContain('"renderCount":2');
  });
});
