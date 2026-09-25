import { expect } from "bun:test";
import { join, relative } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import {
  __resetCacheState,
  __resetDevLoaderCacheState,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheByPath,
  invalidateDevLoaderCacheBySource,
} from "../../../src/server/cache/index.ts";
import { registerDevPagePlugin } from "../../../src/server/dev-page-plugin.ts";
import { createDevtoolsPlugin } from "../../../src/server/devtools/plugin.ts";
import { setProductionTemplateContent } from "../../../src/server/render/template.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

// This scenario runs in the dedicated Worker created by
// dev-isr-loader-cache.test.ts. The Worker isolates the dev/cache module state;
// the parent bun:test case owns test discovery and failure reporting.

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");
const template =
  '<!DOCTYPE html><html><head><!--FURIN_HEAD--></head><body><div id="root"><!--FURIN_HTML--></div><!--FURIN_TAIL--></body></html>';
const timestampRe = /data-timestamp="(\d+)"/;
const originalDevMode = IS_DEV;

setProductionTemplateContent(template);
registerDevPagePlugin();

function prepareDevCacheTest(): void {
  __resetCacheState();
  __resetDevLoaderCacheState();
}

async function runScenario(fn: () => Promise<void>): Promise<void> {
  __setDevMode(false);
  prepareDevCacheTest();
  try {
    await fn();
  } finally {
    __setDevMode(originalDevMode);
    prepareDevCacheTest();
  }
}

function getRoute(
  result: Awaited<ReturnType<typeof scanPages>>,
  pattern: string,
  mode: "isr" | "ssg"
): ResolvedRoute {
  const route = result.routes.find(
    (candidate) => candidate.pattern === pattern && candidate.mode === mode
  );
  if (!route) {
    throw new Error(`No ${pattern} fixture with mode=${mode}`);
  }
  return route;
}

async function requestText(app: AnyElysia, path: string): Promise<string> {
  setProductionTemplateContent(template);
  const response = await app.handle(new Request(`http://localhost${path}`));
  expect(response.status).toBe(200);
  return response.text();
}

function timestampFrom(html: string): string {
  const value = html.match(timestampRe)?.[1];
  expect(value).toBeDefined();
  return value as string;
}

function scanDefaultPages(): ReturnType<typeof scanPages> {
  return scanPages(fixturesDir);
}

function createDevRouteApp(route: ResolvedRoute, root: RootLayout): AnyElysia {
  __setDevMode(true);
  setProductionTemplateContent(template);
  return new Elysia().use(createRoutePlugin(route, root));
}

try {
  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/isr-page", "isr");
    const app = createDevRouteApp(route, result.root);

    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    const cacheKey = `${result.root.path}:/isr-page`;
    const cached = getDevISRLoaderCache(cacheKey);

    expect(cached).toBeDefined();
    expect(cached?.dependencies).toContain(route.path);
    expect(cached?.dependencies).toContain(result.root.path);
    invalidateDevLoaderCacheBySource(route.path);
    expect(getDevISRLoaderCache(cacheKey)).toBeUndefined();

    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    expect(Number(ts2)).toBeGreaterThan(Number(ts1));
  });

  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/isr-page", "isr");
    const app = createDevRouteApp(route, result.root);

    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));

    expect(ts2).toBe(ts1);
  });

  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/isr-query-page", "isr");
    const app = createDevRouteApp(route, result.root);

    const alpha = await requestText(app, "/isr-query-page?tenant=alpha");
    const beta = await requestText(app, "/isr-query-page?tenant=beta");
    expect(alpha).toContain("alpha");
    expect(beta).toContain("beta");

    const alphaKey = `${result.root.path}:/isr-query-page?tenant=alpha`;
    const betaKey = `${result.root.path}:/isr-query-page?tenant=beta`;
    expect(getDevISRLoaderCache(alphaKey)).toBeDefined();
    expect(getDevISRLoaderCache(betaKey)).toBeDefined();

    const outcome = invalidateDevLoaderCacheByPath("/isr-query-page", "page");

    expect(outcome.isr).toBe(2);
    expect(getDevISRLoaderCache(alphaKey)).toBeUndefined();
    expect(getDevISRLoaderCache(betaKey)).toBeUndefined();
  });

  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/isr-page", "isr");
    const app = createDevRouteApp(route, result.root);

    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    const cacheKey = `${result.root.path}:/isr-page`;
    invalidateDevLoaderCacheBySource("/some/unrelated/file.tsx");

    expect(getDevISRLoaderCache(cacheKey)).toBeDefined();
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    expect(ts2).toBe(ts1);
  });

  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/isr-page", "isr");
    __setDevMode(true);
    const app = new Elysia()
      .use(createRoutePlugin(route, result.root))
      .use(createDevtoolsPlugin([route], undefined));

    await requestText(app, "/isr-page");
    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();

    expect(body.caches).toHaveLength(1);
    const [entry] = body.caches;
    expect(entry.path).toBe("/isr-page");
    expect(entry.mode).toBe("isr");
    expect(entry.isFresh).toBe(true);
    expect(entry.revalidateSeconds).toBe(60);
    expect(entry.dependencies).toContain(relative(process.cwd(), route.path).replaceAll("\\", "/"));
    expect(entry.dependencies).toContain(
      relative(process.cwd(), result.root.path).replaceAll("\\", "/")
    );
    expect(entry.fieldNames).toEqual(["timestamp", "params", "path", "query"]);
    expect(JSON.stringify(body)).not.toContain(timestampFrom(await requestText(app, "/isr-page")));
  });

  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/ssg-loader-page", "ssg");
    const app = createDevRouteApp(route, result.root);

    const ts1 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    const cached = getDevSSGLoaderCache(`${result.root.path}:/ssg-loader-page`);

    expect(ts2).toBe(ts1);
    expect(cached?.mode).toBe("ssg");
    expect(cached?.revalidate).toBe(Number.POSITIVE_INFINITY);
  });

  await runScenario(async () => {
    const result = await scanDefaultPages();
    const route = getRoute(result, "/ssg-loader-page", "ssg");
    const app = createDevRouteApp(route, result.root);

    const ts1 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    const cacheKey = `${result.root.path}:/ssg-loader-page`;
    const cached = getDevSSGLoaderCache(cacheKey);

    expect(cached).toBeDefined();
    expect(cached?.dependencies).toContain(route.path);
    expect(cached?.dependencies).toContain(result.root.path);

    const outcome = invalidateDevLoaderCacheBySource(route.path);
    expect(outcome.ssg).toBe(1);
    expect(getDevSSGLoaderCache(cacheKey)).toBeUndefined();

    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    expect(Number(ts2)).toBeGreaterThan(Number(ts1));
  });

  self.postMessage({ type: "pass" });
} catch (error) {
  self.postMessage({
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    type: "fail",
  });
}
