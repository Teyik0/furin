import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import {
  autoInvalidateRegistry,
  revalidateTag,
} from "../../../src/server/auto-invalidate/index.ts";
import {
  __resetDevLoaderCacheState,
  getDevISRLoaderCache,
  invalidateDevLoaderCacheBySource,
  setDevISRLoaderCache,
} from "../../../src/server/cache/dev-loader.ts";
import {
  consumePendingInvalidations,
  revalidatePathForInstance,
} from "../../../src/server/cache/invalidation.ts";
import { devtoolsEventsSnapshot } from "../../../src/server/devtools/hub.ts";
import { createDevtoolsPlugin } from "../../../src/server/devtools/plugin.ts";
import { runWithDevtoolsRequest } from "../../../src/server/devtools/request-context.ts";
import { currentInstance } from "../../../src/server/instance.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

describe("native DevTools plugin", () => {
  const resetState = (): void => {
    __resetDevLoaderCacheState();
    autoInvalidateRegistry.reset();
    consumePendingInvalidations();
  };

  test("rejects non-loopback hosts and cross-origin browser requests", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const hostileHost = await app.handle(
      new Request("http://localhost/_furin/devtools/snapshot", {
        headers: { host: "attacker.test" },
      })
    );
    const hostileOrigin = await app.handle(
      new Request("http://localhost/_furin/devtools/snapshot", {
        headers: { origin: "https://attacker.test" },
      })
    );
    const local = await app.handle(
      new Request("http://localhost/_furin/devtools/snapshot", {
        headers: { origin: "http://localhost" },
      })
    );

    expect(hostileHost.status).toBe(403);
    expect(hostileOrigin.status).toBe(403);
    expect(local.status).toBe(200);
  });

  test("does not retain the legacy DevTools SSE route", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const response = await app.handle(new Request("http://localhost/_furin/devtools/events"));

    expect(response.status).toBe(404);
  });

  test("exposes a strict route snapshot without loader values or absolute paths", async () => {
    const route = {
      mode: "isr",
      page: {
        __type: "FURIN_PAGE",
        _route: { __type: "FURIN_ROUTE" },
        component: () => null,
        loader: () => ({ secret: "never expose me" }),
      },
      path: `${process.cwd()}/src/pages/blog/[slug].tsx`,
      pattern: "/blog/:slug",
      routeChain: [],
      segmentBoundaries: [],
      tags: ["posts"],
    } satisfies ResolvedRoute;
    const app = new Elysia().use(createDevtoolsPlugin([route], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const serialized = JSON.stringify(snapshot);

    expect(response.status).toBe(200);
    expect(snapshot.version).toBe(2);
    expect(snapshot.routes).toEqual([
      {
        file: "src/pages/blog/[slug].tsx",
        hasLoader: true,
        hasRequestLoader: false,
        mode: "isr",
        pattern: "/blog/:slug",
        tags: ["posts"],
      },
    ]);
    expect(serialized).not.toContain("never expose me");
    expect(serialized).not.toContain(process.cwd());
  });

  test("redacts parent directory topology for sources outside the project", async () => {
    const route = {
      mode: "ssr",
      page: {
        __type: "FURIN_PAGE",
        _route: { __type: "FURIN_ROUTE" },
        component: () => null,
      },
      path: `${process.cwd()}/../private-project/pages/account.tsx`,
      pattern: "/account",
      routeChain: [],
      segmentBoundaries: [],
    } satisfies ResolvedRoute;
    const app = new Elysia().use(createDevtoolsPlugin([route], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();

    expect(snapshot.routes[0]?.file).toBe("account.tsx");
    expect(snapshot.routes[0]?.file).not.toContain("../");
    expect(snapshot.routes[0]?.file).not.toContain("private-project");
  });

  test("serves the standalone browser client outside the application bundle", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const response = await app.handle(new Request("http://localhost/_furin/devtools/client.js"));
    const source = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/javascript");
    expect(source).toContain("furin-devtools");
  });

  test("projects cache metadata without exposing cached values", async () => {
    const dependency = `${process.cwd()}/src/pages/posts.tsx`;
    setDevISRLoaderCache(`${dependency}:/posts?draft=1`, {
      dependencies: [dependency],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {
        posts: [{ privateToken: "never expose cached values" }],
        total: 1,
      },
      mode: "isr",
      revalidate: 60,
    });
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const serialized = JSON.stringify(snapshot);

    expect(snapshot.caches).toHaveLength(1);
    expect(snapshot.caches[0]).toMatchObject({
      dependencies: ["src/pages/posts.tsx"],
      fieldNames: ["posts", "total"],
      isFresh: true,
      mode: "isr",
      path: "/posts",
      revalidateSeconds: 60,
    });
    expect(serialized).not.toContain("never expose cached values");
    expect(serialized).not.toContain(process.cwd());
  });

  test("reports a source-invalidated loader entry as stale", async () => {
    const dependency = import.meta.path;
    const key = `${dependency}:/changed`;
    setDevISRLoaderCache(key, {
      dependencies: [dependency],
      generatedAt: 0,
      headers: {},
      loaderData: {},
      mode: "isr",
      revalidate: Number.POSITIVE_INFINITY,
    });

    runWithDevtoolsRequest(new Request("http://localhost/changed"), () => {
      getDevISRLoaderCache(key);
    });
    const event = devtoolsEventsSnapshot().events.findLast(
      (candidate) => candidate.type === "cache.access"
    );

    expect(event).toMatchObject({ outcome: "stale", path: "/changed" });
    await Promise.resolve();
  });

  test("finishes the request timeline when a handler throws synchronously", async () => {
    const cursor = devtoolsEventsSnapshot().lastEventId;

    expect(() =>
      runWithDevtoolsRequest(new Request("http://localhost/throws"), () => {
        throw new Error("sync failure");
      })
    ).toThrow("sync failure");
    const events = devtoolsEventsSnapshot().events.filter((event) => event.id > cursor);

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ path: "/throws", type: "request.started" });
    expect(events[1]).toMatchObject({
      path: "/throws",
      status: 500,
      type: "request.finished",
    });
    await Promise.resolve();
  });

  test("records path invalidations even outside a request", async () => {
    setDevISRLoaderCache(`${process.cwd()}/src/pages/posts.tsx:/posts`, {
      dependencies: [],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr",
      revalidate: 60,
    });
    revalidatePathForInstance(currentInstance(), "/posts", "page");
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const event = snapshot.events.find(
      (candidate: { type: string }) => candidate.type === "cache.invalidated"
    );

    expect(event).toMatchObject({
      deleted: true,
      reason: "path",
      target: "/posts",
    });
  });

  test("records source invalidations without absolute file paths", async () => {
    const source = `${process.cwd()}/src/pages/posts.tsx`;
    setDevISRLoaderCache(`${source}:/posts`, {
      dependencies: [source],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr",
      revalidate: 60,
    });
    invalidateDevLoaderCacheBySource(source);
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
    const snapshot = await response.json();
    const event = snapshot.events.find(
      (candidate: { reason?: string }) => candidate.reason === "source"
    );

    expect(event).toMatchObject({
      deleted: true,
      reason: "source",
      target: "src/pages/posts.tsx",
    });
    expect(JSON.stringify(event)).not.toContain(process.cwd());
  });

  test("records tag invalidations as tag operations", async () => {
    try {
      setDevISRLoaderCache(`${process.cwd()}/src/pages/posts.tsx:/posts`, {
        dependencies: [],
        generatedAt: Date.now(),
        headers: {},
        loaderData: {},
        mode: "isr",
        revalidate: 60,
      });
      autoInvalidateRegistry.registerLoaderTags("/posts", ["posts"]);

      revalidateTag("posts");
      const event = devtoolsEventsSnapshot().events.findLast(
        (candidate) => candidate.type === "cache.invalidated"
      );

      expect(event).toMatchObject({
        deleted: true,
        reason: "tag",
        target: "posts",
      });
    } finally {
      resetState();
      await Promise.resolve();
    }
  });
});
