import { expect } from "bun:test";
import { cpSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { furin } from "../../../src/furin.ts";
import {
  __resetDevLoaderCacheState,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheByPath,
  invalidateDevLoaderCacheBySource,
} from "../../../src/server/cache/index.ts";
import { allInstances, type FurinInstance, withInstance } from "../../../src/server/instance.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";

// This scenario runs in the dedicated Worker created by
// dev-isr-loader-cache.test.ts. The Worker isolates the dev/cache module state;
// the parent bun:test case owns test discovery and failure reporting.

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");
const timestampRe = /data-timestamp="(\d+)"/;

// `__resetCacheState()` would also forget the mounted runtime; the dev loader
// reset clears every registered runtime's loader caches.
function prepareDevCacheTest(): void {
  __resetDevLoaderCacheState();
}

async function requestText(app: AnyElysia, path: string): Promise<string> {
  const response = await app.handle(new Request(`http://localhost${path}`));
  expect(response.status).toBe(200);
  return response.text();
}

function timestampFrom(html: string): string {
  const value = html.match(timestampRe)?.[1];
  expect(value).toBeDefined();
  return value as string;
}

/** Mounts the default page fixtures through a development `furin()`. */
async function mountDevelopmentPages(
  appPath: string
): Promise<{ app: AnyElysia; instance: FurinInstance; pagesDir: string }> {
  const pagesDir = join(appPath, "src/pages");
  rmSync(pagesDir, { force: true, recursive: true });
  cpSync(fixturesDir, pagesDir, { recursive: true });
  process.chdir(appPath);
  __setDevMode(true);
  const app = new Elysia().use(await furin({ pagesDir }));
  const instance = allInstances().find((candidate) => candidate.pagesDir === pagesDir);
  if (!instance) {
    throw new Error(`No furin() runtime registered for ${pagesDir}`);
  }
  return { app, instance, pagesDir };
}

const originalCwd = process.cwd();
const tmpApp = createTmpApp("cli-app");

try {
  const { app, instance, pagesDir } = await mountDevelopmentPages(tmpApp.path);
  const rootPath = `${pagesDir}/root.tsx`;
  const scoped = <T>(fn: () => T): T => withInstance(instance, fn);
  const runScenario = async (fn: () => Promise<void>): Promise<void> => {
    prepareDevCacheTest();
    try {
      await fn();
    } finally {
      prepareDevCacheTest();
    }
  };

  await runScenario(async () => {
    const pagePath = `${pagesDir}/isr-page.tsx`;
    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    const cacheKey = `${rootPath}:/isr-page`;
    const cached = scoped(() => getDevISRLoaderCache(cacheKey));

    expect(cached).toBeDefined();
    expect(cached?.dependencies).toContain(pagePath);
    expect(cached?.dependencies).toContain(rootPath);
    scoped(() => invalidateDevLoaderCacheBySource(pagePath));
    expect(scoped(() => getDevISRLoaderCache(cacheKey))).toBeUndefined();

    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    expect(Number(ts2)).toBeGreaterThan(Number(ts1));
  });

  await runScenario(async () => {
    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));

    expect(ts2).toBe(ts1);
  });

  await runScenario(async () => {
    const alpha = await requestText(app, "/isr-query-page?tenant=alpha");
    const beta = await requestText(app, "/isr-query-page?tenant=beta");
    expect(alpha).toContain("alpha");
    expect(beta).toContain("beta");

    const alphaKey = `${rootPath}:/isr-query-page?tenant=alpha`;
    const betaKey = `${rootPath}:/isr-query-page?tenant=beta`;
    expect(scoped(() => getDevISRLoaderCache(alphaKey))).toBeDefined();
    expect(scoped(() => getDevISRLoaderCache(betaKey))).toBeDefined();

    const outcome = scoped(() => invalidateDevLoaderCacheByPath("/isr-query-page", "page"));

    expect(outcome.isr).toBe(2);
    expect(scoped(() => getDevISRLoaderCache(alphaKey))).toBeUndefined();
    expect(scoped(() => getDevISRLoaderCache(betaKey))).toBeUndefined();
  });

  await runScenario(async () => {
    const ts1 = timestampFrom(await requestText(app, "/isr-page"));
    const cacheKey = `${rootPath}:/isr-page`;
    scoped(() => invalidateDevLoaderCacheBySource("/some/unrelated/file.tsx"));

    expect(scoped(() => getDevISRLoaderCache(cacheKey))).toBeDefined();
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/isr-page"));
    expect(ts2).toBe(ts1);
  });

  await runScenario(async () => {
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
    expect(entry.dependencies).toContain(
      relative(process.cwd(), `${pagesDir}/isr-page.tsx`).replaceAll("\\", "/")
    );
    expect(entry.dependencies).toContain(relative(process.cwd(), rootPath).replaceAll("\\", "/"));
    expect(entry.fieldNames).toEqual(["timestamp", "params", "path", "query"]);
    // Cache entries expose field names, never loader values. (The event log
    // carries wall-clock timestamps that can equal this Date.now() value.)
    expect(JSON.stringify(body.caches)).not.toContain(
      timestampFrom(await requestText(app, "/isr-page"))
    );
  });

  await runScenario(async () => {
    const ts1 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    await Bun.sleep(20);
    const ts2 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    const cached = scoped(() => getDevSSGLoaderCache(`${rootPath}:/ssg-loader-page`));

    expect(ts2).toBe(ts1);
    expect(cached?.mode).toBe("ssg");
    expect(cached?.revalidate).toBe(Number.POSITIVE_INFINITY);
  });

  await runScenario(async () => {
    const pagePath = `${pagesDir}/ssg-loader-page.tsx`;
    const ts1 = timestampFrom(await requestText(app, "/ssg-loader-page"));
    const cacheKey = `${rootPath}:/ssg-loader-page`;
    const cached = scoped(() => getDevSSGLoaderCache(cacheKey));

    expect(cached).toBeDefined();
    expect(cached?.dependencies).toContain(pagePath);
    expect(cached?.dependencies).toContain(rootPath);

    const outcome = scoped(() => invalidateDevLoaderCacheBySource(pagePath));
    expect(outcome.ssg).toBe(1);
    expect(scoped(() => getDevSSGLoaderCache(cacheKey))).toBeUndefined();

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
} finally {
  // The working directory is process-wide, not per Worker.
  process.chdir(originalCwd);
  tmpApp.cleanup();
}
