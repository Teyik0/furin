import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import "../../setup/evlog-mock";

import {
  __resetCacheState,
  isrCache,
  revalidatePath,
  waitForPendingISRRevalidations,
} from "../../../src/server/cache/index.ts";
import { handleISR } from "../../../src/server/render/index.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { notFound } from "../../../src/shared/not-found.ts";

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

function waitForBackground(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 2000;
  async function poll(): Promise<void> {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  }
  return poll();
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

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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

  const result = await scanPages(join(import.meta.dir, "../../fixtures/pages/default"));
  const matchedIsrRoute = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (!matchedIsrRoute) {
    throw new Error("Route /isr-page not found");
  }
  const isrRoute: ResolvedRoute = { ...matchedIsrRoute, mode: "isr" };

  let staleHtml = "<html>stale-redirect</html>";
  isrCache.set("/isr-page/redirect", { generatedAt: 0, html: staleHtml, revalidate: 60 });
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
  await waitForBackground(() => revalidationAttempts === 1, "redirect revalidation did not settle");
  await waitForPendingISRRevalidations();
  expect(isrCache.get("/isr-page/redirect")?.html).toBe(staleHtml);

  __resetCacheState();
  staleHtml = "<html>stale-error</html>";
  isrCache.set("/isr-page/error", { generatedAt: 0, html: staleHtml, revalidate: 60 });
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
  await waitForBackground(() => revalidationAttempts === 1, "error revalidation did not settle");
  await waitForPendingISRRevalidations();
  expect(isrCache.get("/isr-page/error")?.html).toBe(staleHtml);

  __resetCacheState();
  staleHtml = "<html>stale-not-found</html>";
  isrCache.set("/isr-page/not-found", { generatedAt: 0, html: staleHtml, revalidate: 60 });
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
  await waitForBackground(
    () => !isrCache.has("/isr-page/not-found"),
    "not-found revalidation did not invalidate cache"
  );
  await waitForPendingISRRevalidations();
  expect(isrCache.has("/isr-page/not-found")).toBe(false);
  const missCtx = createMockLoaderContext({ path: "/isr-page/not-found" });
  await handleISR(route, missCtx, result.root, "");
  expect(missCtx.set.status).toBe(404);

  __resetCacheState();
  staleHtml = "<html>stale-race</html>";
  const cacheKey = "/isr-page/race";
  const gate = createDeferred();
  let loaderReleased = false;
  isrCache.set(cacheKey, { generatedAt: 0, html: staleHtml, revalidate: 60 });
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
    await waitForBackground(() => revalidationAttempts === 1, "race revalidation did not start");
    revalidatePath(cacheKey, "page");
    expect(isrCache.has(cacheKey)).toBe(false);
  } finally {
    gate.resolve();
  }

  await waitForBackground(() => loaderReleased, "race revalidation did not complete");
  await waitForPendingISRRevalidations();
  expect(isrCache.has(cacheKey)).toBe(false);

  __resetCacheState();
  const missCacheKey = "/isr-page/miss-race";
  const missGate = createDeferred();
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
  await waitForBackground(() => missLoaderStarted, "cache-miss render did not start");
  isrCache.set(missCacheKey, { generatedAt: 0, html: "superseded", revalidate: 60 });
  revalidatePath(missCacheKey, "page");
  missGate.resolve();

  await rendering;

  expect(isrCache.has(missCacheKey)).toBe(false);
  expect(invalidatedMissCtx.set.headers["cache-control"]).toBe("no-store");
}
