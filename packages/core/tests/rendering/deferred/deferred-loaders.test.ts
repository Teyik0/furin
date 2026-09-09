import { describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { defer } from "../../../src/client";
import { runLoaders } from "../../../src/server/render/loaders.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

function makeCtx(overrides: Partial<Context> = {}): Context {
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

function makeRoute(
  pageLoader: ((ctx: Record<string, unknown>) => unknown) | undefined,
  routeLoaders: ((ctx: Record<string, unknown>) => unknown)[]
): ResolvedRoute {
  return {
    mode: "ssr",
    page: pageLoader
      ? {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
          loader: pageLoader as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>,
        }
      : {
          __type: "FURIN_PAGE" as const,
          _route: { __type: "FURIN_ROUTE" as const },
          component: () => null,
        },
    path: "/test",
    pattern: "/test",
    routeChain: routeLoaders.map((loader) => ({
      __type: "FURIN_ROUTE" as const,
      loader: loader as (ctx: Record<string, unknown>) => Promise<Record<string, unknown>>,
    })),
    segmentBoundaries: [],
  } as unknown as ResolvedRoute;
}

describe("runLoaders — DeferredData", () => {
  test("normal loader (without defer) → syncData contains everything, deferredPromises absent", async () => {
    const route = makeRoute(() => ({ count: 42, title: "hello" }), []);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toMatchObject({ count: 42, title: "hello" });
    expect(result.deferredPromises).toBeUndefined();
  });

  test("loader with defer() → syncData contains scalars, deferredPromises the Promises", async () => {
    const statsPromise = Promise.resolve(99);
    const route = makeRoute(() => defer({ stats: statsPromise, title: "hello" }), []);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toMatchObject({ title: "hello" });
    expect(result.deferredPromises).toBeDefined();
    expect(result.deferredPromises?.stats).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.stats).toBe(99);
  });

  test("loader with defer() preserves user data named __isDeferred", async () => {
    const route = makeRoute(
      () => defer({ __isDeferred: "user-data", stats: Promise.resolve(99) }),
      []
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData.__isDeferred).toBe("user-data");
    expect(await result.deferredPromises?.stats).toBe(99);
  });

  test("Promises in defer() are NOT awaited in syncData", async () => {
    let resolved = false;
    const slowPromise = new Promise<number>((r) =>
      setTimeout(() => {
        resolved = true;
        r(1);
      }, 50)
    );
    const route = makeRoute(() => defer({ x: slowPromise }), []);

    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    // runLoaders should return immediately without waiting for the slow Promise
    expect(resolved).toBe(false);
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.x).toBeInstanceOf(Promise);
  });

  test("multiple deferred Promises are all in deferredPromises", async () => {
    const route = makeRoute(
      () =>
        defer({
          stats: Promise.resolve(1),
          title: "board",
          users: Promise.resolve([]),
        }),
      []
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }

    expect(result.syncData).toMatchObject({ title: "board" });
    expect(result.deferredPromises).toHaveProperty("stats");
    expect(result.deferredPromises).toHaveProperty("users");
  });

  test("thenables in defer() are treated as deferred Promises", async () => {
    const thenable = {
      // biome-ignore lint/suspicious/noThenProperty: intentional thenable — testing that defer() treats objects with a then method as deferred Promises
      then(resolve: (value: number) => void) {
        resolve(7);
      },
    };
    const route = makeRoute(() => defer({ stats: thenable, title: "hello" }), []);

    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ title: "hello" });
    expect(result.syncData).not.toHaveProperty("stats");
    expect(result.deferredPromises?.stats).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.stats).toBe(7);
  });

  test("loader in routeChain (non-page) → normal data, no deferred split", async () => {
    const route = makeRoute(() => ({ pageTitle: "page" }), [() => ({ routeData: "from-route" })]);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ pageTitle: "page", routeData: "from-route" });
    expect(result.deferredPromises).toBeUndefined();
  });

  test("route loader returning defer() → deferred fields stream alongside page data", async () => {
    const route = makeRoute(
      () => ({ pageTitle: "page" }),
      [() => defer({ shared: Promise.resolve("layout-async") })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ pageTitle: "page" });
    expect(result.deferredPromises?.shared).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.shared).toBe("layout-async");
  });

  test("layout deferred + page sync → layout Promises split, layout scalars merged into syncData", async () => {
    const route = makeRoute(
      () => ({ count: 3, pageTitle: "page" }),
      [() => defer({ user: "alice", widgets: Promise.resolve(["w1", "w2"]) })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ count: 3, pageTitle: "page", user: "alice" });
    expect(result.syncData).not.toHaveProperty("widgets");
    expect(result.deferredPromises?.widgets).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.widgets).toEqual(["w1", "w2"]);
  });

  test("layout deferred + page deferred → all Promises merged into a single deferredPromises", async () => {
    const route = makeRoute(
      () => defer({ pageTitle: "page", stats: Promise.resolve(42) }),
      [() => defer({ user: "alice", widgets: Promise.resolve(["w1"]) })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ pageTitle: "page", user: "alice" });
    expect(result.deferredPromises).toHaveProperty("widgets");
    expect(result.deferredPromises).toHaveProperty("stats");
    expect(await result.deferredPromises?.stats).toBe(42);
    expect(await result.deferredPromises?.widgets).toEqual(["w1"]);
  });

  test("two layouts in chain, only one deferred → only its Promises are split out", async () => {
    const route = makeRoute(
      () => ({ pageTitle: "page" }),
      [() => ({ org: "acme" }), () => defer({ user: "alice", widgets: Promise.resolve(["w1"]) })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ org: "acme", pageTitle: "page", user: "alice" });
    expect(result.deferredPromises).toBeDefined();
    expect(result.deferredPromises).toHaveProperty("widgets");
    expect(Object.keys(result.deferredPromises ?? {})).toEqual(["widgets"]);
  });

  test("key collision between layout and page defer → page wins (last-spread semantics)", async () => {
    const layoutPromise = Promise.resolve("from-layout");
    const pagePromise = Promise.resolve("from-page");
    const route = makeRoute(
      () => defer({ stats: pagePromise }),
      [() => defer({ stats: layoutPromise })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.stats).toBe(pagePromise);
    expect(await result.deferredPromises?.stats).toBe("from-page");
  });

  test("layout deferred Promise that rejects → exposed as a rejected Promise in deferredPromises", async () => {
    const failure = new Error("boom");
    const rejected = Promise.reject(failure);
    // Avoid unhandled-rejection noise; the consumer (streaming layer) will catch.
    rejected.catch(() => {
      /* intentional */
    });
    const route = makeRoute(() => ({ pageTitle: "page" }), [() => defer({ broken: rejected })]);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.deferredPromises?.broken).toBeInstanceOf(Promise);
    await expect(result.deferredPromises?.broken).rejects.toThrow("boom");
  });

  test("key switching from layout-deferred to page-sync → page-sync wins exclusively (stale deferred is dropped)", async () => {
    // Regression: cross-map merging used to leave both `allSync.stats = 42`
    // AND `allDeferred.stats = Promise<X>` when a later loader replaced a
    // deferred field with a sync one. The wire would then ship the sync value
    // AND a stale deferred resolution chunk for the same key.
    const route = makeRoute(() => ({ stats: 42 }), [() => defer({ stats: Promise.resolve(999) })]);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData.stats).toBe(42);
    expect(result.deferredPromises).toBeUndefined();
  });

  test("key switching from layout-sync to page-deferred → page-deferred wins exclusively (stale sync is dropped)", async () => {
    const route = makeRoute(() => defer({ stats: Promise.resolve(999) }), [() => ({ stats: 42 })]);
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    // The deferred replacement wins → page's deferred Promise is exposed and
    // the layout's stale sync 42 must NOT remain in syncData.
    expect(result.syncData).not.toHaveProperty("stats");
    expect(result.deferredPromises?.stats).toBeInstanceOf(Promise);
    expect(await result.deferredPromises?.stats).toBe(999);
  });

  test("child loader awaits a parent-deferred field with a single await", async () => {
    // Parent defers a Promise<X>. The child loader reads it through the
    // createLoaderCtx proxy. Thanks to JS Promise-chaining auto-flatten, a
    // single `await` is sufficient at runtime to obtain X — no `await await`
    // dance. This test guards that runtime contract; the matching type-level
    // contract lives in tests/types.test.tsx.
    const route = makeRoute(
      async (ctx: Record<string, unknown>) => {
        const slow = ctx.slow as Promise<string>;
        const value = await slow;
        return { received: value };
      },
      [() => defer({ slow: Promise.resolve("from-parent") })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ received: "from-parent" });
  });

  test("child loader can re-defer a parent-deferred field via defer({ mySlow: ctx.slow })", async () => {
    // A child loader forwards a parent-deferred field by re-wrapping it in its
    // own `defer()`. The end-to-end wire chunk must carry the resolved value —
    // not a nested Promise — so the client-side <Await> consumes X directly.
    const route = makeRoute(
      (ctx: Record<string, unknown>) =>
        defer({ mySlow: ctx.slow as Promise<string>, scalar: "ok" }),
      [() => defer({ slow: Promise.resolve("from-parent") })]
    );
    const result = await runLoaders(route, makeCtx());

    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    expect(result.syncData).toMatchObject({ scalar: "ok" });
    expect(result.deferredPromises?.mySlow).toBeInstanceOf(Promise);
    // Single await on the forwarded field yields the original parent value
    // (the parent's Promise chaining + the child's Promise chaining both auto-
    // flatten, so no nested Promise reaches the wire).
    expect(await result.deferredPromises?.mySlow).toBe("from-parent");
  });
});
