import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement, type ReactNode } from "react";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
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
import {
  createInstance,
  registerInstance,
  unregisterInstance,
  withInstance,
} from "../../../src/server/instance.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { warmSSGCache } from "../../../src/server/render/ssg.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionApp } from "../../support/production-app.ts";

const originalDevMode = IS_DEV;
afterAll(() => __setDevMode(originalDevMode));

const rootTerminal = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }: { children: ReactNode }) =>
    createElement(
      "html",
      { lang: "en" },
      createElement("head", null, createElement(HeadContent)),
      createElement("body", null, children, createElement(Scripts))
    )
  );

/** Mounts `/ssg-page` as an SSG page whose loader is `loader`. */
function mountSsgPage(loader: () => unknown, pageCache: PageCacheAdapter) {
  const route = defineRoute()
    .config({ layout: rootTerminal, mode: "ssg" })
    .loader(loader as () => { timestamp: number })
    .page(({ timestamp }) => createElement("main", null, String(timestamp)));
  return mountProductionApp({
    buildId: "build-a",
    pageCache,
    pages: [{ pattern: "/ssg-page", route }],
    root: rootTerminal,
  });
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
      throw new Error("Timed out waiting for the SSG render to start");
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for an observable render state.
    await Bun.sleep(1);
  }
}

test.serial(
  "SSG uses the shared page cache for runtime artifacts",
  (done) => {
    runSharedSsgCache().then(() => done(), done);
  },
  15_000
);

async function runSharedSsgCache(): Promise<void> {
  __setDevMode(false);
  let loaderCalls = 0;
  const cache = createMemoryPageCache();
  const identity: PageCacheIdentity = {
    buildId: "build-a",
    key: "/ssg-page",
    mode: "ssg",
    path: "/ssg-page",
    scope: "",
    tags: [],
  };
  const { app } = await mountSsgPage(() => {
    loaderCalls += 1;
    return { timestamp: loaderCalls };
  }, cache);

  try {
    await app.handle(new Request("http://localhost/ssg-page"));
    await cache.invalidate({ kind: "path", path: "/ssg-page", scope: "", type: "page" });
    await app.handle(new Request("http://localhost/ssg-page"));
  } finally {
    __resetCacheState();
    __resetCompileContext();
  }

  expect(await cache.read(identity)).not.toBeNull();
  expect(loaderCalls).toBe(2);
}

test.serial(
  "SSG renders fresh with no-store when the shared cache is unavailable",
  (done) => {
    runUnavailableSsgCache().then(() => done(), done);
  },
  15_000
);

async function runUnavailableSsgCache(): Promise<void> {
  __setDevMode(false);
  const unavailable = (): Promise<never> => Promise.reject(new Error("cache unavailable"));
  const cache: PageCacheAdapter = {
    acquire: unavailable,
    commit: unavailable,
    invalidate: unavailable,
    read: unavailable,
    release: unavailable,
  };
  const { app } = await mountSsgPage(() => ({ timestamp: 1 }), cache);

  try {
    const response = await app.handle(new Request("http://localhost/ssg-page"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  } finally {
    __resetCacheState();
    __resetCompileContext();
  }
}

test.serial(
  "SSG invalidation fences a render already in progress",
  (done) => {
    runSsgInvalidationRace().then(() => done(), done);
  },
  15_000
);

async function runSsgInvalidationRace(): Promise<void> {
  __setDevMode(false);
  const gate = createDeferred();
  let loaderCalls = 0;
  const cache = createMemoryPageCache();
  const { app } = await mountSsgPage(async () => {
    loaderCalls += 1;
    if (loaderCalls === 1) {
      await gate.promise;
    }
    return { timestamp: loaderCalls };
  }, cache);

  try {
    const first = app.handle(new Request("http://localhost/ssg-page"));
    await waitFor(() => loaderCalls === 1);
    await cache.invalidate({ kind: "path", path: "/ssg-page", scope: "", type: "page" });
    gate.resolve();
    const response = await first;
    expect(response.headers.get("cache-control")).toBe("no-store");
    await app.handle(new Request("http://localhost/ssg-page"));
  } finally {
    gate.resolve();
    __resetCacheState();
    __resetCompileContext();
  }

  expect(loaderCalls).toBe(2);
}

test.serial(
  "SSG warm-up populates the configured shared cache",
  (done) => {
    runSharedSsgWarmup().then(() => done(), done);
  },
  15_000
);

async function runSharedSsgWarmup(): Promise<void> {
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
      staticParams: () => [{ slug: "one" }],
    },
    pattern: "/products/:slug",
  };
  const instance = registerInstance(createInstance("", "/ssg-warmup/pages"));
  instance.buildId = "build-a";
  const cache = createMemoryPageCache();
  setPageCacheAdapter(instance, cache);
  const identity: PageCacheIdentity = {
    buildId: instance.buildId,
    key: "/products/one",
    mode: "ssg",
    path: "/products/one",
    scope: "",
    tags: route.tags ?? [],
  };

  try {
    await withInstance(instance, () => warmSSGCache([route], result.root, "http://localhost"));
    expect(await cache.read(identity)).not.toBeNull();
    expect(loaderCalls).toBe(1);
  } finally {
    resetPageCacheAdapter(instance);
    __resetCacheState();
    unregisterInstance(instance);
  }
}
