import { expect } from "bun:test";
import { cpSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { furin } from "../../../src/furin.ts";
import {
  __resetDevLoaderCacheState,
  getAllDevISRLoaderEntries,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  invalidateDevLoaderCacheByPath,
  invalidateDevLoaderCacheBySource,
} from "../../../src/server/cache/index.ts";
import { allInstances, type FurinInstance, withInstance } from "../../../src/server/instance.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { createTmpApp } from "../../support/app-fixtures.ts";

// A subprocess isolates both the dev/cache module state and process-wide CWD.

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

// Reads its requestLoader field outside a Suspense boundary: production PPR
// rejects the page, and development must too.
const pprOutsideSuspensePage = `import { defineRoute } from "@teyik0/furin";
import { use } from "react";

export const route = defineRoute("/ppr-outside-suspense")
  .config({ mode: "isr", revalidate: 60 })
  .requestLoader(({ cookies }) => ({ session: cookies.get("session") }))
  .page(({ session }) => <main>{String(use(session))}</main>);
`;

// A valid PPR page whose public loader stamps its run.
const pprLoaderPage = `import { Await, defineRoute } from "@teyik0/furin";
import { Suspense } from "react";

export const route = defineRoute("/ppr-loader-page")
  .config({ mode: "ssg" })
  .requestLoader(({ cookies }) => ({ session: cookies.get("session") }))
  .loader(() => ({ timestamp: Date.now() }))
  .page(({ session, timestamp }) => (
    <main data-timestamp={String(timestamp)}>
      <Suspense fallback="Loading">
        <Await resolve={session}>{(value) => <strong>{String(value)}</strong>}</Await>
      </Suspense>
    </main>
  ));
`;

/** The public `timestamp` field of a page's navigation data. */
async function dataTimestamp(app: AnyElysia, path: string): Promise<string> {
  const response = await app.handle(
    new Request(`http://localhost${path}?_furin=data`, { headers: { cookie: "session=alice" } })
  );
  expect(response.status).toBe(200);
  const { syncData } = await parseDeferredNdjson(
    response.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
    undefined
  );
  return String(syncData.timestamp);
}

/** Mounts the default page fixtures through a development `furin()`. */
async function mountDevelopmentPages(
  appPath: string
): Promise<{ app: AnyElysia; instance: FurinInstance; pagesDir: string }> {
  const pagesDir = join(appPath, "src/pages");
  rmSync(pagesDir, { force: true, recursive: true });
  cpSync(fixturesDir, pagesDir, { recursive: true });
  writeFileSync(join(pagesDir, "ppr-outside-suspense.tsx"), pprOutsideSuspensePage);
  writeFileSync(join(pagesDir, "ppr-loader-page.tsx"), pprLoaderPage);
  process.chdir(appPath);
  __setDevMode(true);
  const app = new Elysia().use(await furin({ pagesDir }));
  // Furin stores pagesDir with POSIX separators on every platform.
  const instance = allInstances().find(
    (candidate) => candidate.pagesDir === pagesDir.replaceAll("\\", "/")
  );
  if (!instance) {
    throw new Error(`No furin() runtime registered for ${pagesDir}`);
  }
  // Cache keys and dependencies use the POSIX path Furin stores.
  return { app, instance, pagesDir: instance.pagesDir };
}

let scenarioResult: { type: "pass" } | { type: "fail"; message: string; stack: string | undefined };
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
    const plain = timestampFrom(await requestText(app, "/isr-page"));
    await Bun.sleep(20);
    expect(timestampFrom(await requestText(app, "/isr-page?utm_source=mail"))).toBe(plain);

    const alpha = timestampFrom(
      await requestText(app, "/isr-query-page?tenant=alpha&utm_source=mail")
    );
    await Bun.sleep(20);
    expect(
      timestampFrom(await requestText(app, "/isr-query-page?utm_source=news&tenant=alpha"))
    ).toBe(alpha);
    expect(scoped(() => getAllDevISRLoaderEntries().map(([key]) => key)).toSorted()).toEqual([
      `${rootPath}:/isr-page`,
      `${rootPath}:/isr-query-page?tenant=alpha`,
    ]);
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

  await runScenario(async () => {
    const response = await app.handle(
      new Request("http://localhost/ppr-outside-suspense", {
        headers: { cookie: "session=alice" },
      })
    );

    // The production PPR diagnostic, shown in the development overlay.
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("__FURIN_DEV_DIAGNOSTIC__");
    expect(body).toContain("requestLoader fields must be consumed inside a Suspense boundary");
  });

  await runScenario(async () => {
    const documentTimestamp = timestampFrom(await requestText(app, "/ssg-loader-page"));
    await Bun.sleep(20);

    expect(await dataTimestamp(app, "/ssg-loader-page")).toBe(documentTimestamp);
  });

  await runScenario(async () => {
    const pagePath = `${pagesDir}/ppr-loader-page.tsx`;
    const document = await app.handle(
      new Request("http://localhost/ppr-loader-page", { headers: { cookie: "session=alice" } })
    );
    expect(document.status).toBe(200);
    const html = await document.text();
    expect(html).toContain("<strong>alice</strong>");
    const documentTimestamp = timestampFrom(html);
    await Bun.sleep(20);
    expect(await dataTimestamp(app, "/ppr-loader-page")).toBe(documentTimestamp);

    // A source edit drops the public data navigation serves too.
    scoped(() => invalidateDevLoaderCacheBySource(pagePath));
    await Bun.sleep(20);
    expect(Number(await dataTimestamp(app, "/ppr-loader-page"))).toBeGreaterThan(
      Number(documentTimestamp)
    );
  });

  scenarioResult = { type: "pass" };
} catch (error) {
  scenarioResult = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
    type: "fail",
  };
} finally {
  // Restore and clean up before reporting the scenario result.
  process.chdir(originalCwd);
  tmpApp.cleanup();
}

// Keep IPC alive until the parent confirms receipt, including on Windows.
const receipt = Promise.withResolvers<void>();
process.on("message", (message: { type: string }) => {
  if (message.type === "verify-awaiting-receipt") {
    process.send?.({ type: "awaiting-receipt" });
  } else if (message.type === "result-received") {
    receipt.resolve();
  }
});
process.send?.(scenarioResult);
await receipt.promise;
process.exit(scenarioResult.type === "pass" ? 0 : 1);
