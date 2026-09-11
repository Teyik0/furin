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
      'import { furin, revalidatePath } from "@teyik0/furin";',
      'import { Elysia } from "elysia";',
      "",
      "const app = new Elysia()",
      '  .get("/api/health", () => "ok")',
      '  .post("/api/revalidate", () => {',
      '    revalidatePath("/", "page");',
      '    return "invalidated";',
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
  writeAppFile(
    app.path,
    "src/pages/news.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "isr", revalidate: 90 })',
      "  .page(() => <main>News</main>);",
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
      const buildConfigs: Bun.BuildConfig[] = [];

      const result = await withBuildStub(
        () =>
          buildApp({
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
      expect(existsSync(join(outputDir, "static/_client/_hydrate.js"))).toBe(true);
      expect(existsSync(join(outputDir, "static/.gitkeep"))).toBe(true);
      expect(lstatSync(join(functionsDir, "news-isr.func")).isSymbolicLink()).toBe(true);
      expect(
        JSON.parse(readFileSync(join(functionsDir, "news-isr.prerender-config.json"), "utf8"))
      ).toEqual({ expiration: 90, passQuery: true });
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
        build.entrypoints.some((entrypoint) => entrypoint.endsWith("_vercel-entry.ts"))
      );
      const entrypoint = serverBuild?.entrypoints[0] as string;
      const source = serverBuild?.files?.[entrypoint] as string;
      expect(source).toContain("@vercel+functions");
      expect(source).toContain("invalidateByTag");
      expect(source).toContain("waitUntil");
      expect(source).toContain("serverModule.default");
      expect(source).toContain("app.handle(restoredRequest)");

      const manifest = result.targets.vercel;
      if (!manifest || !("isrRoutes" in manifest)) {
        throw new TypeError("Expected the Vercel target manifest");
      }
      expect(manifest.isrRoutes).toEqual(["/news"]);
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
    await buildApp({ rootDir: app.path, target: "vercel" });

    const handlerPath = join(
      app.path,
      ".vercel/output/functions/__server.func/index.js"
    );
    const script = `
      const pending = [];
      const purged = [];
      globalThis[Symbol.for("@vercel/request-context")] = {
        get: () => ({
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
      const api = await handler.fetch(new Request("http://furin.test/api/health"));
      const ssg = await handler.fetch(new Request("http://furin.test/"));
      const data = await handler.fetch(new Request("http://furin.test/_furin/data?path=%2F"));
      const isr = await handler.fetch(new Request("http://furin.test/news-isr?__furin_path=/news"));
      const invalidation = await handler.fetch(new Request("http://furin.test/api/revalidate", { method: "POST" }));
      await Promise.all(pending);
      console.log("__FURIN_RESULT__" + JSON.stringify({
        apiBody: await api.text(),
        apiStatus: api.status,
        dataCacheControl: data.headers.get("cache-control"),
        dataTag: data.headers.get("vercel-cache-tag"),
        invalidationBody: await invalidation.text(),
        isrBody: await isr.text(),
        isrTag: isr.headers.get("vercel-cache-tag"),
        purged,
        ssgBody: await ssg.text(),
        ssgTag: ssg.headers.get("vercel-cache-tag"),
      }));
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
    expect(result.apiStatus).toBe(200);
    expect(result.apiBody).toBe("ok");
    expect(result.dataCacheControl).toBe(
      "public, max-age=0, must-revalidate, s-maxage=31536000"
    );
    expect(result.dataTag).toBe("/");
    expect(result.invalidationBody).toBe("invalidated");
    expect(result.purged).toEqual([["/"]]);
    expect(result.ssgTag).toBe("/");
    expect(result.ssgBody).toContain("Home page");
    expect(result.isrTag).toBe("/news");
    expect(result.isrBody).toContain("News");
  });
});
