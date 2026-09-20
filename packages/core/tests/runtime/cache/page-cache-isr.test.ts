import { expect, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { revalidateTag } from "../../../src/server/auto-invalidate/index.ts";
import {
  __resetCacheState,
  revalidatePath,
  waitForPendingISRRevalidations,
} from "../../../src/server/cache/index.ts";
import {
  createMemoryPageCache,
  type PageCacheAdapter,
  type PageCacheIdentity,
} from "../../../src/server/cache/page-cache.ts";
import {
  resetPageCacheAdapter,
  setPageCacheAdapter,
} from "../../../src/server/cache/page-cache-state.ts";
import { createInstance, registerInstance, withInstance } from "../../../src/server/instance.ts";
import { handleISR } from "../../../src/server/render/index.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";

function createContext(path: string): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path,
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request(`http://localhost${path}`),
    set: { headers: {} as HTTPHeaders },
  } as Context;
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the ISR render to start");
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for an observable render state.
    await Bun.sleep(1);
  }
}

let fixturePromise: ReturnType<typeof scanPages> | undefined;

function scanFixture(): ReturnType<typeof scanPages> {
  fixturePromise ??= scanPages(join(import.meta.dir, "../../fixtures/pages/default"));
  return fixturePromise;
}

test("ISR replicas use the configured page cache as their source of truth", (done) => {
  const scenario = runSharedCacheSourceOfTruth();
  scenario.then(() => done(), done);
}, 15_000);

async function runSharedCacheSourceOfTruth(): Promise<void> {
  __setDevMode(false);
  const result = await scanFixture();
  const matched = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (matched === undefined) {
    throw new Error("Route /isr-page not found");
  }

  let loaderCalls = 0;
  const route: ResolvedRoute = {
    ...matched,
    mode: "isr",
    page: {
      ...matched.page,
      loader: () => {
        loaderCalls += 1;
        return { timestamp: loaderCalls };
      },
    },
  };
  const instance = createInstance("", "/app/pages");
  instance.buildId = "build-a";
  setPageCacheAdapter(instance, createMemoryPageCache());

  try {
    await withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
    await withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
  } finally {
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }

  expect(loaderCalls).toBe(1);
}

test("revalidatePath fences an ISR render already running on another replica", (done) => {
  const scenario = runInvalidationRace();
  scenario.then(() => done(), done);
}, 15_000);

async function runInvalidationRace(): Promise<void> {
  __setDevMode(false);
  const result = await scanFixture();
  const matched = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (matched === undefined) {
    throw new Error("Route /isr-page not found");
  }

  const gate = createDeferred();
  let loaderCalls = 0;
  let renderStarted = false;
  const route: ResolvedRoute = {
    ...matched,
    mode: "isr",
    page: {
      ...matched.page,
      loader: async () => {
        loaderCalls += 1;
        if (loaderCalls === 1) {
          renderStarted = true;
          await gate.promise;
        }
        return { timestamp: loaderCalls };
      },
    },
  };
  const instance = registerInstance(createInstance("", "/replica/pages"));
  instance.buildId = "build-a";
  setPageCacheAdapter(instance, createMemoryPageCache());

  try {
    const firstRender = withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
    await waitFor(() => renderStarted);
    await revalidatePath("/isr-page", "page");
    gate.resolve();
    await firstRender;

    await withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
  } finally {
    gate.resolve();
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }

  expect(loaderCalls).toBe(2);
}

test("stale ISR refreshes the shared entry", (done) => {
  const scenario = runStaleISRRefresh();
  scenario.then(() => done(), done);
}, 15_000);

async function runStaleISRRefresh(): Promise<void> {
  __setDevMode(false);
  const result = await scanFixture();
  const matched = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (matched === undefined) {
    throw new Error("Route /isr-page not found");
  }

  let loaderCalls = 0;
  const route: ResolvedRoute = {
    ...matched,
    mode: "isr",
    page: {
      ...matched.page,
      loader: () => {
        loaderCalls += 1;
        return { timestamp: loaderCalls };
      },
    },
  };
  const instance = registerInstance(createInstance("", "/shared-cache/pages"));
  instance.buildId = "build-a";
  const cache = createMemoryPageCache();
  const identity: PageCacheIdentity = {
    buildId: instance.buildId,
    key: "/isr-page",
    mode: "isr",
    path: "/isr-page",
    scope: "",
    tags: route.tags ?? [],
  };
  const lease = await cache.acquire({ identity, leaseMs: 30_000 });
  if (lease === null) {
    throw new Error("Expected the stale-entry lease");
  }
  await cache.commit({
    entry: { cachedAt: 0, payload: "<html>stale</html>", revalidate: 60 },
    identity,
    lease,
  });
  setPageCacheAdapter(instance, cache);

  try {
    const html = await withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
    expect(html).toBe("<html>stale</html>");
    await waitForPendingISRRevalidations();
    expect((await cache.read(identity))?.payload).not.toBe("<html>stale</html>");
  } finally {
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }

  expect(loaderCalls).toBe(1);
}

test("revalidateTag invalidates shared ISR entries", async () => {
  const instance = registerInstance(createInstance("", "/tagged/pages"));
  instance.buildId = "build-a";
  const cache = createMemoryPageCache();
  const identity: PageCacheIdentity = {
    buildId: instance.buildId,
    key: "/posts",
    mode: "isr",
    path: "/posts",
    scope: "",
    tags: ["posts"],
  };
  const lease = await cache.acquire({ identity, leaseMs: 30_000 });
  if (lease === null) {
    throw new Error("Expected the tagged-entry lease");
  }
  await cache.commit({
    entry: { cachedAt: Date.now(), payload: "<html>posts</html>", revalidate: 60 },
    identity,
    lease,
  });
  setPageCacheAdapter(instance, cache);

  try {
    expect(await revalidateTag("posts")).toBe(true);
    expect(await cache.read(identity)).toBeNull();
  } finally {
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }
});

test("ISR renders fresh with no-store when the shared cache is unavailable", async () => {
  __setDevMode(false);
  const result = await scanFixture();
  const matched = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (matched === undefined) {
    throw new Error("Route /isr-page not found");
  }

  let loaderCalls = 0;
  const route: ResolvedRoute = {
    ...matched,
    mode: "isr",
    page: {
      ...matched.page,
      loader: () => {
        loaderCalls += 1;
        return { timestamp: loaderCalls };
      },
    },
  };
  const unavailable = (): Promise<never> => Promise.reject(new Error("cache unavailable"));
  const cache: PageCacheAdapter = {
    acquire: unavailable,
    commit: unavailable,
    invalidate: unavailable,
    read: unavailable,
    release: unavailable,
  };
  const instance = createInstance("", "/unavailable/pages");
  instance.buildId = "build-a";
  setPageCacheAdapter(instance, cache);
  const ctx = createContext("/isr-page");

  try {
    const html = await withInstance(instance, () =>
      handleISR(route, ctx, result.root, instance.buildId)
    );
    expect(html).toContain("ISR Page");
  } finally {
    resetPageCacheAdapter(instance);
  }

  expect(loaderCalls).toBe(1);
  expect(ctx.set.headers["cache-control"]).toBe("no-store");
});

test("concurrent ISR misses share one render", (done) => {
  const scenario = runConcurrentISRMisses();
  scenario.then(() => done(), done);
}, 15_000);

async function runConcurrentISRMisses(): Promise<void> {
  __setDevMode(false);
  const result = await scanFixture();
  const matched = result.routes.find((candidate) => candidate.pattern === "/isr-page");
  if (matched === undefined) {
    throw new Error("Route /isr-page not found");
  }

  const gate = createDeferred();
  let loaderCalls = 0;
  const route: ResolvedRoute = {
    ...matched,
    mode: "isr",
    page: {
      ...matched.page,
      loader: async () => {
        loaderCalls += 1;
        if (loaderCalls === 1) {
          await gate.promise;
        }
        return { timestamp: loaderCalls };
      },
    },
  };
  const instance = createInstance("", "/concurrent/pages");
  instance.buildId = "build-a";
  setPageCacheAdapter(instance, createMemoryPageCache());

  try {
    const first = withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
    await waitFor(() => loaderCalls === 1);
    const second = withInstance(instance, () =>
      handleISR(route, createContext("/isr-page"), result.root, instance.buildId)
    );
    await Bun.sleep(10);
    expect(loaderCalls).toBe(1);
    gate.resolve();
    await Promise.all([first, second]);
  } finally {
    gate.resolve();
    resetPageCacheAdapter(instance);
  }

  expect(loaderCalls).toBe(1);
}
