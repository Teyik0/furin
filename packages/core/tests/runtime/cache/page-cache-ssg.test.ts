import { expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { __resetCacheState } from "../../../src/server/cache/index.ts";
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
import { scanPages } from "../../../src/server/router/discovery.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";

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
      throw new Error("Timed out waiting for the SSG render to start");
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for an observable render state.
    await Bun.sleep(1);
  }
}

test.serial("SSG uses the shared page cache for runtime artifacts", async () => {
  __setDevMode(false);
  const result = await scanPages(join(import.meta.dir, "../../fixtures/pages/default"));
  const matched = result.routes.find((candidate) => candidate.pattern === "/ssg-page");
  if (matched === undefined) {
    throw new Error("Route /ssg-page not found");
  }

  let loaderCalls = 0;
  const route: ResolvedRoute = {
    ...matched,
    mode: "ssg",
    page: {
      ...matched.page,
      loader: () => {
        loaderCalls += 1;
        return { timestamp: loaderCalls };
      },
    },
  };
  const instance = registerInstance(createInstance("", "/ssg/pages"));
  instance.buildId = "build-a";
  const cache = createMemoryPageCache();
  setPageCacheAdapter(instance, cache);
  const identity: PageCacheIdentity = {
    buildId: instance.buildId,
    key: "/ssg-page",
    mode: "ssg",
    path: "/ssg-page",
    scope: "",
    tags: route.tags ?? [],
  };
  const app = new Elysia().use(createRoutePlugin(route, result.root, instance.buildId));

  try {
    await withInstance(instance, () => app.handle(new Request("http://localhost/ssg-page")));
    await cache.invalidate({ kind: "path", path: "/ssg-page", scope: "", type: "page" });
    await withInstance(instance, () => app.handle(new Request("http://localhost/ssg-page")));
  } finally {
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }

  expect(await cache.read(identity)).not.toBeNull();
  expect(loaderCalls).toBe(2);
});

test.serial("SSG renders fresh with no-store when the shared cache is unavailable", async () => {
  __setDevMode(false);
  const result = await scanPages(join(import.meta.dir, "../../fixtures/pages/default"));
  const matched = result.routes.find((candidate) => candidate.pattern === "/ssg-page");
  if (matched === undefined) {
    throw new Error("Route /ssg-page not found");
  }
  const route: ResolvedRoute = { ...matched, mode: "ssg" };
  const unavailable = (): Promise<never> => Promise.reject(new Error("cache unavailable"));
  const cache: PageCacheAdapter = {
    acquire: unavailable,
    commit: unavailable,
    invalidate: unavailable,
    read: unavailable,
    release: unavailable,
  };
  const instance = registerInstance(createInstance("", "/ssg-unavailable/pages"));
  instance.buildId = "build-a";
  setPageCacheAdapter(instance, cache);
  const app = new Elysia().use(createRoutePlugin(route, result.root, instance.buildId));

  try {
    const response = await withInstance(instance, () =>
      app.handle(new Request("http://localhost/ssg-page"))
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }
});

test.serial("SSG invalidation fences a render already in progress", async () => {
  __setDevMode(false);
  const result = await scanPages(join(import.meta.dir, "../../fixtures/pages/default"));
  const matched = result.routes.find((candidate) => candidate.pattern === "/ssg-page");
  if (matched === undefined) {
    throw new Error("Route /ssg-page not found");
  }
  const gate = createDeferred();
  let loaderCalls = 0;
  const route: ResolvedRoute = {
    ...matched,
    mode: "ssg",
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
  const instance = registerInstance(createInstance("", "/ssg-race/pages"));
  instance.buildId = "build-a";
  const cache = createMemoryPageCache();
  setPageCacheAdapter(instance, cache);
  const app = new Elysia().use(createRoutePlugin(route, result.root, instance.buildId));

  try {
    const first = withInstance(instance, () =>
      app.handle(new Request("http://localhost/ssg-page"))
    );
    await waitFor(() => loaderCalls === 1);
    await cache.invalidate({ kind: "path", path: "/ssg-page", scope: "", type: "page" });
    gate.resolve();
    const response = await first;
    expect(response.headers.get("cache-control")).toBe("no-store");
    await withInstance(instance, () => app.handle(new Request("http://localhost/ssg-page")));
  } finally {
    gate.resolve();
    resetPageCacheAdapter(instance);
    __resetCacheState();
  }

  expect(loaderCalls).toBe(2);
});
