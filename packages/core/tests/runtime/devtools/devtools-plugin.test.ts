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
import { appendDevtoolsEvent, devtoolsEventsSnapshot } from "../../../src/server/devtools/hub.ts";
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

  test("limits concurrent event streams and releases capacity on cancel", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const streams = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.handle(new Request("http://localhost/_furin/devtools/events"))
      )
    );

    const rejected = await app.handle(new Request("http://localhost/_furin/devtools/events"));
    expect(rejected.status).toBe(429);

    await streams[0]?.body?.cancel();
    const replacement = await app.handle(new Request("http://localhost/_furin/devtools/events"));
    expect(replacement.status).toBe(200);

    await replacement.body?.cancel();
    await Promise.all(streams.slice(1).map((stream) => stream.body?.cancel()));
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

  test("serves a dedicated dashboard outside the application document", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(new Request("http://localhost/_furin/devtools"));
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("<title>Furin DevTools</title>");
    expect(html).toContain("/_furin/devtools/dashboard.js");
    expect(html).toContain("/_furin/devtools/dashboard.css");
  });

  test("retains validated browser HMR events across a full reload", async () => {
    appendDevtoolsEvent({
      changedModule: "src/pages/current.tsx",
      cycleId: "current-cycle",
      detectedAt: Date.now(),
      timestamp: Date.now(),
      type: "hmr.cycle.started",
    });
    const cursor = devtoolsEventsSnapshot().lastEventId;
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(
      new Request("http://localhost/_furin/devtools/browser-events", {
        body: JSON.stringify({
          clientId: "browser-tab",
          clientTimestamp: 42,
          cycleId: "build-7",
          reason: "hmr-connection-recovered",
          type: "hmr.full-reload",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    const events = devtoolsEventsSnapshot().events.filter((event) => event.id > cursor);

    expect(response.status).toBe(204);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      clientId: "browser-tab",
      cycleId: "build-7",
      reason: "hmr-connection-recovered",
      type: "hmr.full-reload",
    });
  });

  test("keeps an unmatched browser phase explicit and redacts its module path", async () => {
    appendDevtoolsEvent({
      changedModule: "src/pages/current.tsx",
      cycleId: "active-cycle",
      detectedAt: Date.now(),
      timestamp: Date.now(),
      type: "hmr.cycle.started",
    });
    const cursor = devtoolsEventsSnapshot().lastEventId;
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(
      new Request("http://localhost/_furin/devtools/browser-events", {
        body: JSON.stringify({
          clientId: "background-tab",
          clientTimestamp: Date.now(),
          cycleId: null,
          durationMs: 3,
          module: `${process.cwd()}/src/pages/card.tsx`,
          phase: "paint",
          type: "hmr.client.phase",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    const event = devtoolsEventsSnapshot().events.find((candidate) => candidate.id > cursor);

    expect(response.status).toBe(204);
    expect(event).toMatchObject({
      clientId: "background-tab",
      cycleId: null,
      module: "src/pages/card.tsx",
      phase: "paint",
    });
  });

  test("rejects malformed browser DevTools events", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));

    const response = await app.handle(
      new Request("http://localhost/_furin/devtools/browser-events", {
        body: JSON.stringify({
          clientId: "browser-tab",
          clientTimestamp: 42,
          cycleId: null,
          reason: "invented-reason",
          type: "hmr.full-reload",
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );

    expect(response.status).toBe(400);
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

  test("streams live events after the requested sequence", async () => {
    const app = new Elysia().use(createDevtoolsPlugin([], undefined));
    const cursor = devtoolsEventsSnapshot().lastEventId;
    const response = await app.handle(
      new Request(`http://localhost/_furin/devtools/events?after=${cursor}`)
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const connected = await reader?.read();
    expect(new TextDecoder().decode(connected?.value)).toContain(": connected");

    appendDevtoolsEvent({
      method: "GET",
      operationId: null,
      path: "/live",
      requestId: "request-live",
      timestamp: Date.now(),
      type: "request.started",
    });
    const event = await reader?.read();
    const payload = new TextDecoder().decode(event?.value);

    expect(payload).toContain("event: furin.devtools");
    expect(payload).toContain('"path":"/live"');
    await reader?.cancel();
  });
});
