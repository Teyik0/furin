import { afterEach, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildClient } from "../../src/build/client.ts";
import { clientModuleKey } from "../../src/plugin/transform-client-module.ts";
import { scanPages } from "../../src/server/router/discovery.ts";
import { createTmpApp, type TmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

const tmpApps: TmpApp[] = [];

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

/**
 * index and blog share `a.ts`; `a.ts`, the blog page and the client-only scene
 * share `deep.ts`. Bun splits both into their own chunks, so the index route
 * reaches `deep.ts` only through `a.ts` (page → a → deep).
 */
function createPreloadApp(): TmpApp {
  const app = createTmpApp("cli-app");
  tmpApps.push(app);
  writeAppFile(app.path, "src/lib/deep.ts", 'export const deep = () => "DEEP_MARKER";\n');
  writeAppFile(
    app.path,
    "src/lib/a.ts",
    'import { deep } from "./deep";\nexport const a = () => `A_MARKER ${deep()}`;\n'
  );
  writeAppFile(
    app.path,
    "src/lib/scene.ts",
    'import { deep } from "./deep";\nexport const mount = () => `SCENE_MARKER ${deep()}`;\n'
  );
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { clientModule, preloadClientModule } from "@teyik0/furin/client";',
      'import { a } from "../lib/a";',
      'import { route as rootRoute } from "./root";',
      'export const scene = clientModule(() => import("../lib/scene"));',
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .page(() => {",
      "    preloadClientModule(scene);",
      "    return <main>INDEX_MARKER {a()}</main>;",
      "  });",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { t } from "elysia";',
      'import { a } from "../../lib/a";',
      'import { deep } from "../../lib/deep";',
      'import { route as rootRoute } from "../root";',
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg", params: t.Object({ slug: t.String() }) })',
      "  .page(() => <article>{a()}</article>);",
    ].join("\n")
  );
  writeAppFile(
    app.path,
    "src/pages/about.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { deep } from "../lib/deep";',
      'import { route as rootRoute } from "./root";',
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .page(() => <main>{deep()}</main>);",
    ].join("\n")
  );
  return app;
}

async function buildPreloadApp(publicPath: string, preloadRouteChunks: boolean) {
  const app = createPreloadApp();
  const { root, routes } = await scanPages(join(app.path, "src/pages"));
  const outDir = join(app.path, ".furin/build/preload");
  const result = await buildClient(routes, {
    basePath: "",
    clientLogging: false,
    outDir,
    preloadRouteChunks,
    publicPath,
    rootLayout: root.path,
  });
  const clientDir = join(outDir, "client");
  const chunks = readdirSync(clientDir)
    .filter((file) => file.endsWith(".js"))
    .map((file) => ({ code: readFileSync(join(clientDir, file), "utf8"), file }));
  const chunkWith = (marker: string) => {
    const chunk = chunks.find(({ code }) => code.includes(marker));
    if (!chunk) {
      throw new Error(`no chunk contains ${marker}`);
    }
    return `${publicPath}${chunk.file}`;
  };
  return { app, chunkWith, chunks, result };
}

describe.serial("client preload manifest", () => {
  test("lists a route's page chunk and all its transitive static imports", async () => {
    const { chunkWith, result } = await buildPreloadApp("/_client/", true);
    const hrefs = result.preloadManifest.routes["/"] ?? [];

    const expected = [chunkWith("INDEX_MARKER"), chunkWith("A_MARKER"), chunkWith("DEEP_MARKER")];
    expect(new Set(expected).size).toBe(3);
    expect(hrefs).toEqual(expect.arrayContaining(expected));
    expect(hrefs).not.toContain(result.entryChunk);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  test("inlines a client module's chunk URLs, prefixed with the base path", async () => {
    const { app, chunkWith, chunks, result } = await buildPreloadApp("/docs/_client/", true);
    const key = clientModuleKey(join(app.path, "src/lib/scene.ts"));
    const hrefs = result.preloadManifest.modules[key] ?? [];

    expect(hrefs).toEqual(
      expect.arrayContaining([chunkWith("SCENE_MARKER"), chunkWith("DEEP_MARKER")])
    );
    expect(hrefs.every((href) => href.startsWith("/docs/_client/"))).toBe(true);
    expect(chunks.some(({ code }) => code.includes("__FURIN_CLIENT_MODULE_"))).toBe(false);
    expect(chunkWith(JSON.stringify(hrefs))).toBe(chunkWith("INDEX_MARKER"));
  });

  test("a static export preloads route and client module chunks in <head>", async () => {
    const app = createPreloadApp();
    const outDir = join(app.path, "dist");
    writeAppFile(
      app.path,
      "furin.config.ts",
      'export default { static: { basePath: "/docs", onSSR: "skip", outDir: "dist" } };\n'
    );

    const result = await runCli(["build", "--target", "static"], { cwd: app.path });
    expect(result.exitCode, result.stderr).toBe(0);

    const html = readFileSync(join(outDir, "index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const preloads = [...head.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map(
      (match) => match[1] as string
    );
    const clientDir = join(outDir, "_client");
    const files = readdirSync(clientDir).filter((file) => file.endsWith(".js"));
    const hrefWith = (marker: string) =>
      `/docs/_client/${files.find((file) => readFileSync(join(clientDir, file), "utf8").includes(marker))}`;

    expect(preloads).toEqual(
      expect.arrayContaining([
        hrefWith("INDEX_MARKER"),
        hrefWith("A_MARKER"),
        hrefWith("SCENE_MARKER"),
        hrefWith("DEEP_MARKER"),
      ])
    );
    expect(new Set(preloads).size).toBe(preloads.length);
  });

  test("opting out of route chunk preloads keeps client module preloads", async () => {
    const { app, result } = await buildPreloadApp("/_client/", false);
    const key = clientModuleKey(join(app.path, "src/lib/scene.ts"));

    expect(result.preloadManifest.routes).toEqual({});
    expect(result.preloadManifest.modules[key]?.length).toBeGreaterThan(0);
  });
});
