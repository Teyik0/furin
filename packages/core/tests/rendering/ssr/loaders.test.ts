import { describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { FurinRscRenderError } from "../../../src/rsc/render-error.ts";
import { runInSyntheticRenderScope } from "../../../src/server/context-logger.ts";
import { runLoaders, runPublicLoaders } from "../../../src/server/render/loaders.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { evlogErrorMock, evlogWarnMock } from "../../setup/evlog-mock.ts";

const CACHED_PUBLIC_LOADERS_RE = /Cached public loaders/;

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

describe("runLoaders requestLoader", () => {
  test("runs public and request loaders concurrently", async () => {
    const publicGate = Promise.withResolvers<void>();
    const requestGate = Promise.withResolvers<void>();
    const started: string[] = [];
    const route = {
      mode: "ssr",
      page: {},
      path: "/parallel.tsx",
      pattern: "/parallel",
      requestKeys: [],
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          loader: async () => {
            started.push("public");
            await publicGate.promise;
            return {};
          },
          requestLoader: async () => {
            started.push("request");
            await requestGate.promise;
            return {};
          },
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = runLoaders(route, createMockLoaderContext({ path: "/parallel" }));

    await Promise.resolve();
    expect(started).toEqual(["public", "request"]);
    publicGate.resolve();
    requestGate.resolve();
    await result;
  });

  test("propagates a requestLoader failure with no declared fields", async () => {
    const route = {
      mode: "ssr",
      page: {},
      path: "/check.tsx",
      pattern: "/check",
      requestKeys: [],
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          requestLoader: () => {
            throw new Error("Access denied");
          },
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runLoaders(route, createMockLoaderContext({ path: "/check" }));
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect((result.error as Error).message).toBe("Access denied");
    }
  });

  test("preserves request field failures without unhandled rejections while public loaders run", async () => {
    const failure = new Error("Request loader unavailable");
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    const route = {
      mode: "ssr",
      page: {
        loader: async () => {
          await Bun.sleep(30);
          return {};
        },
      },
      path: "/request-failure.tsx",
      pattern: "/request-failure",
      requestKeys: ["user", "permissions"],
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          requestLoader: () => {
            throw failure;
          },
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;
    process.on("unhandledRejection", onUnhandled);
    try {
      const result = await runLoaders(route, createMockLoaderContext({ path: "/request-failure" }));
      expect(result.type).toBe("data");
      if (result.type === "data") {
        await expect(result.deferredPromises?.user).rejects.toBe(failure);
        await expect(result.deferredPromises?.permissions).rejects.toBe(failure);
      }
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("rejects loader data that uses framework-reserved keys", async () => {
    const route = {
      mode: "ssr",
      page: {
        loader: () => ({ __furinStatus: 404 }),
      },
      path: "/reserved.tsx",
      pattern: "/reserved",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runLoaders(route, createMockLoaderContext({ path: "/reserved" }));

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toBeInstanceOf(Error);
      expect((result.error as Error).message).toContain('__furinStatus" is reserved');
    }
  });

  test("rejects loader data keys that would be shadowed by the route context", async () => {
    for (const reservedKey of [
      "children",
      "key",
      "params",
      "path",
      "query",
      "ref",
      "then",
      "catch",
      "finally",
      "toJSON",
    ]) {
      const route = {
        mode: "ssr",
        page: {
          loader: () => ({ [reservedKey]: "dead-on-arrival" }),
        },
        path: `/${reservedKey}-shadow.tsx`,
        pattern: `/${reservedKey}-shadow`,
        routeChain: [],
        segmentBoundaries: [],
      } as unknown as ResolvedRoute;

      // biome-ignore lint/performance/noAwaitInLoops: parametrised contract check
      const result = await runLoaders(route, createMockLoaderContext({ path: "/shadow" }));

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.error).toBeInstanceOf(Error);
        expect((result.error as Error).message).toContain(`"${reservedKey}" is reserved`);
      }
    }
  });

  test("warns in dev when a deeper loader overwrites a parent loader key", async () => {
    __setDevMode(true);
    evlogWarnMock.mockClear();
    try {
      const route = {
        mode: "ssr",
        page: {
          // Awaiting a parent field forces the accumulation chain (and its
          // collision warning) to settle before runLoaders resolves.
          loader: async ({ user }: { user: Promise<string> }) => ({
            greeting: `hello ${await user}`,
          }),
        },
        path: "/collision.tsx",
        pattern: "/collision",
        routeChain: [{ loader: () => ({ user: "parent" }) }, { loader: () => ({ user: "child" }) }],
        segmentBoundaries: [],
      } as unknown as ResolvedRoute;

      const result = await runInSyntheticRenderScope(
        () => runLoaders(route, createMockLoaderContext({ path: "/collision" })),
        { path: "/collision" }
      );
      expect(result.type).toBe("data");

      expect(evlogWarnMock).toHaveBeenCalled();
      const message = evlogWarnMock.mock.calls.map((call) => String(call[0])).join("\n");
      expect(message).toContain('"user"');
      expect(message).toContain("/collision");
    } finally {
      __setDevMode(false);
    }
  });

  test("does not warn when parent and child loader keys are disjoint", async () => {
    __setDevMode(true);
    evlogWarnMock.mockClear();
    try {
      const route = {
        mode: "ssr",
        page: {
          loader: async ({ user, org }: { user: Promise<string>; org: Promise<string> }) => ({
            both: `${await user}/${await org}`,
          }),
        },
        path: "/disjoint.tsx",
        pattern: "/disjoint",
        routeChain: [{ loader: () => ({ user: "parent" }) }, { loader: () => ({ org: "child" }) }],
        segmentBoundaries: [],
      } as unknown as ResolvedRoute;

      const result = await runInSyntheticRenderScope(
        () => runLoaders(route, createMockLoaderContext({ path: "/disjoint" })),
        { path: "/disjoint" }
      );
      expect(result.type).toBe("data");

      expect(evlogWarnMock).not.toHaveBeenCalled();
    } finally {
      __setDevMode(false);
    }
  });

  test("runs private data once with a read-only request context", async () => {
    let calls = 0;
    const route = {
      mode: "ssr",
      page: {},
      path: "/with-loader.tsx",
      pattern: "/with-loader",
      requestKeys: ["user"],
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          requestLoader: (ctx: { cookies: Map<string, string | undefined> }) => {
            calls += 1;
            expect("set" in ctx).toBe(false);
            expect("redirect" in ctx).toBe(false);
            return { user: ctx.cookies.get("session") };
          },
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;
    const context = createMockLoaderContext({
      cookie: { session: { value: "alice" } } as unknown as Context["cookie"],
      path: "/with-loader",
    });

    const result = await runLoaders(route, context);

    expect(result.type).toBe("data");
    if (result.type === "data") {
      expect(await result.deferredPromises?.user).toBe("alice");
    }
    expect(calls).toBe(1);

    const rawCookieResult = await runLoaders(
      route,
      createMockLoaderContext({
        cookie: undefined,
        request: new Request("http://localhost/with-loader", {
          headers: { cookie: 'other=unused; session="Alice%20Bob"' },
        }),
      })
    );
    expect(rawCookieResult.type).toBe("data");
    if (rawCookieResult.type === "data") {
      expect(await rawCookieResult.deferredPromises?.user).toBe("Alice Bob");
    }
    expect(calls).toBe(2);
  });

  test("resolves request fields independently when a loader returns promises", async () => {
    const slow = Promise.withResolvers<string>();
    const route = {
      mode: "ssr",
      page: {},
      path: "/independent.tsx",
      pattern: "/independent",
      requestKeys: ["fast", "slow"],
      routeChain: [
        {
          __type: "FURIN_ROUTE",
          requestLoader: () => ({ fast: Promise.resolve("ready"), slow: slow.promise }),
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runLoaders(route, createMockLoaderContext({ path: "/independent" }));
    expect(result.type).toBe("data");
    if (result.type !== "data") {
      return;
    }
    let slowResolved = false;
    result.deferredPromises?.slow?.then(() => {
      slowResolved = true;
    });
    expect(await result.deferredPromises?.fast).toBe("ready");
    expect(slowResolved).toBe(false);
    slow.resolve("later");
    expect(await result.deferredPromises?.slow).toBe("later");
  });

  test("resolves one layout request field while another loader is still running", async () => {
    const slow = Promise.withResolvers<void>();
    const route = {
      mode: "ssr",
      page: {},
      path: "/separate-loaders.tsx",
      pattern: "/separate-loaders",
      requestKeys: ["fast", "slow"],
      requestKeysByLoader: [["fast"], ["slow"]],
      routeChain: [
        { __type: "FURIN_ROUTE", requestLoader: () => ({ fast: "ready" }) },
        {
          __type: "FURIN_ROUTE",
          requestLoader: async () => {
            await slow.promise;
            return { slow: "later" };
          },
        },
      ],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runLoaders(route, createMockLoaderContext({ path: "/separate-loaders" }));
    expect(result.type).toBe("data");
    if (result.type !== "data") {
      slow.resolve();
      return;
    }
    let fastSettled = false;
    result.deferredPromises?.fast?.then(() => {
      fastSettled = true;
    });
    await Bun.sleep(0);
    expect(fastSettled).toBe(true);
    slow.resolve();
    expect(await result.deferredPromises?.slow).toBe("later");
  });

  test("rejects a private field that would overwrite public loader data", async () => {
    const route = {
      mode: "ssr",
      page: { loader: () => ({ user: "public" }) },
      path: "/collision.tsx",
      pattern: "/collision",
      requestKeys: ["user"],
      routeChain: [{ __type: "FURIN_ROUTE", requestLoader: () => ({ user: "private" }) }],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runLoaders(route, createMockLoaderContext({ path: "/collision" }));
    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.message).toContain("Something went wrong");
      expect((result.error as Error).message).toContain('field "user" collides');
    }
  });

  test("public loaders omit decorated context fields", async () => {
    const route = {
      mode: "ssr",
      page: {
        loader: (ctx: { [key: string]: unknown }) => ({ service: ctx.service }),
      },
      path: "/decorated.tsx",
      pattern: "/decorated",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;
    const context = createMockLoaderContext({
      service: "decorated",
    } as Partial<Context>);

    const result = await runPublicLoaders(route, context);

    expect(result.type).toBe("data");
    if (result.type === "data") {
      expect(await result.syncData.service).toBeUndefined();
    }
  });

  test("public loaders cannot mutate cached response state", async () => {
    const route = {
      mode: "ssr",
      page: {
        loader: (ctx: { [key: string]: unknown }) => ({ set: ctx.set }),
      },
      path: "/blocked.tsx",
      pattern: "/blocked",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    const result = await runPublicLoaders(route, createMockLoaderContext({}));

    expect(result.type).toBe("error");
    if (result.type === "error") {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.message).toBe("Something went wrong");
      expect((result.error as Error).message).toMatch(CACHED_PUBLIC_LOADERS_RE);
    }
  });

  test("logs RSC render errors and preserves their development message", async () => {
    __setDevMode(true);
    evlogErrorMock.mockClear();
    const error = new FurinRscRenderError({
      cause: new TypeError("null is not an object (evaluating 'dispatcher.useContext')"),
      component: "PhoneIcon",
      hook: "useContext",
      operation: "createCompositeComponent",
    });
    const route = {
      mode: "ssr",
      page: {
        loader: () => {
          throw error;
        },
      },
      path: "/rsc-error.tsx",
      pattern: "/rsc-error",
      routeChain: [],
      segmentBoundaries: [],
    } as unknown as ResolvedRoute;

    try {
      const result = await runInSyntheticRenderScope(
        () => runLoaders(route, createMockLoaderContext({ path: "/rsc-error" })),
        { path: "/rsc-error" }
      );

      expect(result.type).toBe("error");
      if (result.type === "error") {
        expect(result.message).toContain("Component: PhoneIcon");
      }
      expect(evlogErrorMock).toHaveBeenCalledWith(error);
    } finally {
      __setDevMode(false);
    }
  });
});

__setDevMode(false);
