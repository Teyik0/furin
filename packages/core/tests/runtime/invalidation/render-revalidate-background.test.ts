import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import {
  __resetCacheState,
  isrCache,
  revalidatePath,
  waitForPendingISRRevalidations,
} from "../../../src/server/cache/index.ts";
import { handleISR } from "../../../src/server/render/index.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { notFound } from "../../../src/shared/not-found.ts";
import { waitFor } from "../../support/wait.ts";

const originalDevMode = IS_DEV;
afterAll(() => __setDevMode(originalDevMode));

function createMockLoaderContext(overrides: Partial<Context>): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/test",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/test"),
    set: { headers: {} as HTTPHeaders },
    ...overrides,
  } as Context;
}

function createISRRoute(
  baseRoute: ResolvedRoute,
  options: {
    loader: ResolvedRoute["page"]["loader"];
    pattern: string;
  }
): ResolvedRoute {
  return {
    ...baseRoute,
    page: {
      ...baseRoute.page,
      loader: options.loader,
    },
    pattern: options.pattern,
  };
}

// The scenario intentionally starts ISR fire-and-forget work from a stale hit;
// Bun's parallel runner can keep that test scope open after the promise settles.
test.serial(
  "ISR background revalidation scenarios",
  (done) => {
    const scenario = runISRBackgroundRevalidationScenarios();
    scenario.then(() => done(), done);
  },
  15_000
);

async function runISRBackgroundRevalidationScenarios(): Promise<void> {
  __setDevMode(false);
  __resetCacheState();

  const result = await scanPages({
    pagesDir: join(import.meta.dir, "../../fixtures/pages/default"),
    prefix: "",
    style: "tanstack",
  });
  const matchedIsrRoute = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (!matchedIsrRoute) {
    throw new Error("Route /isr-page not found");
  }
  const isrRoute: ResolvedRoute = { ...matchedIsrRoute, mode: "isr" };

  let staleHtml = "<html>stale-redirect</html>";
  isrCache.set("/isr-page/redirect", {
    generatedAt: 0,
    html: staleHtml,
    ndjson: "{}\n",
    revalidate: 60,
  });
  let revalidationAttempts = 0;
  let route = createISRRoute(isrRoute, {
    loader: () => {
      revalidationAttempts += 1;
      throw new Response(null, { headers: { Location: "/foo" }, status: 302 });
    },
    pattern: "/isr-page/redirect",
  });
  let html = await handleISR(
    route,
    createMockLoaderContext({ path: "/isr-page/redirect" }),
    result.root,
    ""
  );
  expect(html).toBe(staleHtml);
  await waitFor(() => revalidationAttempts === 1, "redirect revalidation did not settle", 2000);
  await waitForPendingISRRevalidations();
  expect(isrCache.get("/isr-page/redirect")?.html).toBe(staleHtml);

  __resetCacheState();
  staleHtml = "<html>stale-error</html>";
  isrCache.set("/isr-page/error", {
    generatedAt: 0,
    html: staleHtml,
    ndjson: "{}\n",
    revalidate: 60,
  });
  revalidationAttempts = 0;
  route = createISRRoute(isrRoute, {
    loader: () => {
      revalidationAttempts += 1;
      throw new Error("bg-revalidation-boom");
    },
    pattern: "/isr-page/error",
  });
  html = await handleISR(
    route,
    createMockLoaderContext({ path: "/isr-page/error" }),
    result.root,
    ""
  );
  expect(html).toBe(staleHtml);
  await waitFor(() => revalidationAttempts === 1, "error revalidation did not settle", 2000);
  await waitForPendingISRRevalidations();
  expect(isrCache.get("/isr-page/error")?.html).toBe(staleHtml);

  __resetCacheState();
  staleHtml = "<html>stale-not-found</html>";
  isrCache.set("/isr-page/not-found", {
    generatedAt: 0,
    html: staleHtml,
    ndjson: "{}\n",
    revalidate: 60,
  });
  route = createISRRoute(isrRoute, {
    loader: () => notFound({ message: "gone" }),
    pattern: "/isr-page/not-found",
  });
  html = await handleISR(
    route,
    createMockLoaderContext({ path: "/isr-page/not-found" }),
    result.root,
    ""
  );
  expect(html).toBe(staleHtml);
  await waitFor(
    () => !isrCache.has("/isr-page/not-found"),
    "not-found revalidation did not invalidate cache",
    2000
  );
  await waitForPendingISRRevalidations();
  expect(isrCache.has("/isr-page/not-found")).toBe(false);
  const missCtx = createMockLoaderContext({ path: "/isr-page/not-found" });
  await handleISR(route, missCtx, result.root, "");
  expect(missCtx.set.status).toBe(404);

  __resetCacheState();
  staleHtml = "<html>stale-race</html>";
  const cacheKey = "/isr-page/race";
  const gate = Promise.withResolvers<void>();
  let loaderReleased = false;
  isrCache.set(cacheKey, { generatedAt: 0, html: staleHtml, ndjson: "{}\n", revalidate: 60 });
  revalidationAttempts = 0;
  route = createISRRoute(isrRoute, {
    loader: async () => {
      revalidationAttempts += 1;
      await gate.promise;
      loaderReleased = true;
      return { timestamp: Date.now() };
    },
    pattern: cacheKey,
  });

  try {
    html = await handleISR(route, createMockLoaderContext({ path: cacheKey }), result.root, "");
    expect(html).toBe(staleHtml);
    await waitFor(() => revalidationAttempts === 1, "race revalidation did not start", 2000);
    revalidatePath(cacheKey, "page");
    expect(isrCache.has(cacheKey)).toBe(false);
  } finally {
    gate.resolve();
  }

  await waitFor(() => loaderReleased, "race revalidation did not complete", 2000);
  await waitForPendingISRRevalidations();
  expect(isrCache.has(cacheKey)).toBe(false);

  __resetCacheState();
  const missCacheKey = "/isr-page/miss-race";
  const missGate = Promise.withResolvers<void>();
  let missLoaderStarted = false;
  route = createISRRoute(isrRoute, {
    loader: async () => {
      missLoaderStarted = true;
      await missGate.promise;
      return { timestamp: Date.now() };
    },
    pattern: missCacheKey,
  });
  const invalidatedMissCtx = createMockLoaderContext({ path: missCacheKey });
  const rendering = handleISR(route, invalidatedMissCtx, result.root, "");
  await waitFor(() => missLoaderStarted, "cache-miss render did not start", 2000);
  await revalidatePath(missCacheKey, "page");
  missGate.resolve();

  await rendering;

  expect(isrCache.has(missCacheKey)).toBe(false);
  expect(invalidatedMissCtx.set.headers["cache-control"]).toBe("no-store");
}

test.serial(
  "an old 404 revalidation preserves a newer local cache entry",
  (done) => {
    runNotFoundGenerationRace("loader").then(() => done(), done);
  },
  15_000
);

test.serial(
  "an old notFound exception preserves a newer local cache entry",
  (done) => {
    runNotFoundGenerationRace("head").then(() => done(), done);
  },
  15_000
);

async function runNotFoundGenerationRace(source: "head" | "loader"): Promise<void> {
  __setDevMode(false);
  __resetCacheState();
  const { root, routes } = await scanPages({
    pagesDir: join(import.meta.dir, "../../fixtures/pages/default"),
    prefix: "",
    style: "tanstack",
  });
  const base = routes.find((candidate) => candidate.pattern === "/isr-page");
  if (base === undefined) {
    throw new Error("Route /isr-page not found");
  }
  const cacheKey = `/isr-page/not-found-${source}-race`;
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  const oldRoute = createISRRoute(
    { ...base, mode: "isr" },
    {
      loader: async () => {
        started.resolve();
        await gate.promise;
        if (source === "loader") {
          notFound(undefined);
        }
        return { timestamp: 1 };
      },
      pattern: cacheKey,
    }
  );
  if (source === "head") {
    oldRoute.page.head = () => notFound(undefined);
  }
  const freshRoute = createISRRoute(
    { ...base, mode: "isr" },
    {
      loader: () => ({ timestamp: 2 }),
      pattern: cacheKey,
    }
  );
  isrCache.set(cacheKey, {
    generatedAt: 0,
    html: "<html>old</html>",
    ndjson: "{}\n",
    revalidate: 60,
  });
  let freshHtml: string | undefined;
  try {
    await handleISR(oldRoute, createMockLoaderContext({ path: cacheKey }), root, "");
    await started.promise;
    await revalidatePath(cacheKey, "page");
    const rendered = await handleISR(
      freshRoute,
      createMockLoaderContext({ path: cacheKey }),
      root,
      ""
    );
    if (typeof rendered !== "string") {
      throw new Error("Expected freshly rendered ISR HTML");
    }
    freshHtml = rendered;
    expect(freshHtml).toContain('data-timestamp="2"');
    expect(isrCache.get(cacheKey)?.html).toBe(freshHtml);
  } finally {
    gate.resolve();
    await waitForPendingISRRevalidations();
  }
  expect(isrCache.get(cacheKey)?.html).toBe(freshHtml);
}
