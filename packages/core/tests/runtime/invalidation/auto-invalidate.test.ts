import { afterEach, describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import { Elysia } from "elysia";
import {
  autoInvalidateRegistry,
  furinInvalidate,
  revalidateTag,
} from "../../../src/server/auto-invalidate/index.ts";
import {
  __resetCacheState,
  __resetDevLoaderCacheState,
  _runWithRequestInvalidationScope,
  consumePendingInvalidations,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  isrCache,
  revalidatePath,
  setCachePurger,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
  setISRCache,
  setSSGCache,
  ssgCache,
} from "../../../src/server/cache/index.ts";
import { createInstance, registerInstance, withInstance } from "../../../src/server/instance.ts";
import { createDataEndpoint } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { flushMicrotasks } from "../../support/microtasks";

afterEach(async () => {
  __resetCacheState();
  __resetDevLoaderCacheState();
  autoInvalidateRegistry.reset();
  await flushMicrotasks();
});

describe("revalidateTag", () => {
  test("invalidates every production cache path registered under a tag", async () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    setSSGCache("/", { cachedAt: Date.now(), html: "home", ndjson: "{}\n", status: 200 });
    setISRCache("/untagged", { generatedAt: Date.now(), html: "other", revalidate: 60 });

    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const deleted = revalidateTag("board");

    expect(deleted).toBe(true);
    expect(isrCache.has("/board/123")).toBe(false);
    expect(ssgCache.has("/")).toBe(true);
    expect(isrCache.has("/untagged")).toBe(true);
    await flushMicrotasks();
  });

  test("invalidates dev loader caches registered under a tag", async () => {
    const entry = {
      dependencies: [],
      generatedAt: Date.now(),
      headers: {},
      loaderData: {},
      mode: "isr" as const,
      revalidate: 60,
    };
    setDevISRLoaderCache("/repo/src/pages/root.tsx:/board/123", entry);
    setDevSSGLoaderCache("/repo/src/pages/root.tsx:/", { ...entry, mode: "ssg" });

    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const deleted = revalidateTag(["board", "boards"]);

    expect(deleted).toBe(true);
    expect(getDevISRLoaderCache("/repo/src/pages/root.tsx:/board/123")).toBeUndefined();
    expect(getDevSSGLoaderCache("/repo/src/pages/root.tsx:/")).toBeUndefined();
    await flushMicrotasks();
  });

  test("unregisters tag mappings when cached paths are evicted", async () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    revalidateTag("board");
    const second = revalidateTag("board");

    expect(second).toBe(false);
    await flushMicrotasks();
  });

  test("does not evict a sibling instance's page that merely shares the pathname", async () => {
    // Two furin apps mounted in one server: only app A registered the tag for
    // "/x", so app B's unrelated "/x" page must survive the tag invalidation
    // (tags are cross-app, but eviction is per-registering-instance).
    const a = registerInstance(createInstance("/a", "/apps/a"));
    const b = registerInstance(createInstance("/b", "/apps/b"));

    withInstance(a, () => {
      setISRCache("/x", { generatedAt: Date.now(), html: "a:x", revalidate: 60 });
      autoInvalidateRegistry.registerLoaderTags("/x", ["shared"]);
    });
    withInstance(b, () => {
      setISRCache("/x", { generatedAt: Date.now(), html: "b:x", revalidate: 60 });
    });

    const deleted = revalidateTag("shared");

    expect(deleted).toBe(true);
    expect(withInstance(a, () => isrCache.has("/x"))).toBe(false);
    expect(withInstance(b, () => isrCache.has("/x"))).toBe(true);
    await flushMicrotasks();
  });

  test("purges the mounted app's PHYSICAL (prefixed) URL, not the logical path", async () => {
    // The CDN caches physical request URLs, so a `/admin`-mounted instance's
    // logical "/x" must be purged as "/admin/x".
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    const purged: string[][] = [];
    setCachePurger((paths) => {
      purged.push(paths);
      return Promise.resolve();
    });

    withInstance(admin, () => {
      setISRCache("/x", { generatedAt: Date.now(), html: "admin:x", revalidate: 60 });
      autoInvalidateRegistry.registerLoaderTags("/x", ["shared"]);
    });

    revalidateTag("shared");
    await flushMicrotasks();

    expect(purged.flat()).toContain("/admin/x");
    expect(purged.flat()).not.toContain("/x");
  });

  test("cache reset unregisters auto-invalidate entries on the owning instance", async () => {
    // With ≥2 registered instances and no request scope, `currentInstance()`
    // resolves to the default bucket — reset helpers must still scope each
    // cache's onDelete hooks to the instance being cleared, or the path→tag
    // mapping survives on the real instance while the default bucket gets a
    // spurious unregistration.
    const a = registerInstance(createInstance("/a", "/apps/a"));
    registerInstance(createInstance("/b", "/apps/b"));

    withInstance(a, () => {
      setISRCache("/x", { generatedAt: Date.now(), html: "a:x", revalidate: 60 });
      setDevISRLoaderCache("/apps/a/src/pages/root.tsx:/y", {
        dependencies: [],
        generatedAt: Date.now(),
        headers: {},
        loaderData: {},
        mode: "isr",
        revalidate: 60,
      });
      autoInvalidateRegistry.registerLoaderTags("/x", ["shared"]);
      autoInvalidateRegistry.registerLoaderTags("/y", ["shared"]);
    });

    __resetCacheState();

    expect(withInstance(a, () => autoInvalidateRegistry.pathsForTags(["shared"]))).toEqual([]);
    await flushMicrotasks();
  });
});

describe("revalidatePath", () => {
  test("purges the mounted app's PHYSICAL (prefixed) URL, not the logical path", async () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    const purged: string[][] = [];
    setCachePurger((paths) => {
      purged.push(paths);
      return Promise.resolve();
    });

    withInstance(admin, () => {
      setISRCache("/x", { generatedAt: Date.now(), html: "admin:x", revalidate: 60 });
    });

    const deleted = revalidatePath("/x", "page");
    await flushMicrotasks();

    expect(deleted).toBe(true);
    expect(withInstance(admin, () => isrCache.has("/x"))).toBe(false);
    expect(purged.flat()).toContain("/admin/x");
    expect(purged.flat()).not.toContain("/x");
  });
});

describe("furinInvalidate macro", () => {
  test("runs invalidation rules on successful mutation responses", async () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .post("/cards", () => ({ ok: true }), { invalidate: { tags: ["board"] } });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards", { method: "POST" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/board/123")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board/123");
    expect(consumePendingInvalidations()).toEqual([]);
  });

  test("does not invalidate failed mutation responses", async () => {
    setISRCache("/board/123", { generatedAt: Date.now(), html: "board", revalidate: 60 });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .post("/cards", ({ status }) => status("Bad Request", "bad"), {
        invalidate: { tags: ["board"] },
      });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards", { method: "POST" }))
    );

    expect(response.status).toBe(400);
    expect(isrCache.has("/board/123")).toBe(true);
    expect(response.headers.get("x-furin-revalidate")).toBeNull();
  });

  test("data endpoint does not retain uncached dynamic paths", async () => {
    const route = {
      mode: "isr",
      page: {
        loader: () => ({ pageData: "from-page" }),
      },
      path: "/items/[id].tsx",
      pattern: "/items/:id",
      routeChain: [],
      segmentBoundaries: [],
      tags: ["boards"],
    } as unknown as ResolvedRoute;

    autoInvalidateRegistry.reset();
    const app = new Elysia().use(createDataEndpoint([route]));
    for (let index = 0; index < 200; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: requests verify cardinality across paths.
      const response = await app.handle(
        new Request(`http://localhost/_furin/data?path=/items/${index}`)
      );
      expect(response.status).toBe(200);
    }

    expect(autoInvalidateRegistry.pathsForTags(["boards"])).toEqual([]);
  });

  test("two plugins both calling furinInvalidate() + DELETE → header still set (task-manager replica)", async () => {
    // The real task-manager has both boardPlugin and cardPlugin each call
    // `.use(furinInvalidate())`. Both Elysia instances share the same plugin
    // name `furin-invalidate`. This test verifies the second plugin still
    // sees the macro applied to its DELETE route.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const boardPlugin = new Elysia()
      .use(furinInvalidate())
      .post("/boards", () => ({ id: "x" }), { invalidate: { tags: ["boards"] } })
      .delete("/boards/:id", () => ({ ok: true }), { invalidate: { tags: ["boards"] } });

    const cardPlugin = new Elysia()
      .use(furinInvalidate())
      .post("/cards", () => ({ ok: true }), { invalidate: { tags: ["cards"] } });

    const api = new Elysia({ prefix: "/api" }).use(boardPlugin).use(cardPlugin);

    const response = await _runWithRequestInvalidationScope(() =>
      api.handle(new Request("http://localhost/api/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
    expect(isrCache.has("/")).toBe(false);
  });

  test("wrap-with-scope (mirrors furin server) + nested DELETE → header still set (regression for real-server bug)", async () => {
    // Reproduces the exact AsyncLocalStorage wrapping pattern used by
    // `wrapWithRequestScope` in furin.ts to confirm that `app.wrap` preserves
    // the request-scoped invalidation set across the macro afterHandle.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const inner = new Elysia()
      .use(furinInvalidate())
      .delete("/boards/:id", () => ({ ok: true }), { invalidate: { tags: ["boards"] } });

    const api = new Elysia({ prefix: "/api" }).use(inner);

    // Mirror `wrapWithRequestScope`: app.wrap(...) — installs the AsyncLocalStorage
    // scope around the composed handler instead of using the test helper.
    const wrapped = new Elysia()
      .use(api)
      .wrap(
        (handler, _request) => (ctx: unknown) =>
          _runWithRequestInvalidationScope(() => handler(ctx))
      );

    // Note: we deliberately do NOT use _runWithRequestInvalidationScope here —
    // the .wrap() above should be sufficient.
    const response = await wrapped.handle(
      new Request("http://localhost/api/boards/abc", { method: "DELETE" })
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
  });

  test("nested plugin + prefix + DELETE with params → tag invalidation still works", async () => {
    // Mirrors the task-manager structure exactly: a nested plugin that calls
    // furinInvalidate() and is mounted under a prefix, with a DELETE that has
    // a dynamic param. This is the configuration that was reported as broken.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const boardPlugin = new Elysia()
      .use(furinInvalidate())
      .get("/boards", () => ({ list: [] }))
      .post("/boards", () => ({ id: "new" }), { invalidate: { tags: ["boards"] } })
      .delete("/boards/:boardId", () => ({ ok: true }), {
        invalidate: { tags: ["boards"] },
      })
      .get("/boards/:boardId", () => ({ id: "x" }));

    const api = new Elysia({ prefix: "/api" }).use(boardPlugin);

    const response = await _runWithRequestInvalidationScope(() =>
      api.handle(new Request("http://localhost/api/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
    expect(isrCache.has("/")).toBe(false);
  });

  test("DELETE + tag-based invalidate → header is set and cache is busted (regression)", async () => {
    // Mirrors the task-manager DELETE /boards/:id flow that was failing:
    // the home page caches under tag "boards"; deleting a board should bust
    // it and ship x-furin-revalidate: / on the DELETE response so the client
    // refreshes the home page.
    setISRCache("/", { generatedAt: Date.now(), html: "home", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .delete("/boards/:id", () => ({ ok: true }), { invalidate: { tags: ["boards"] } });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
  });

  test("supports path-based invalidation rules", async () => {
    setISRCache("/blog/post", { generatedAt: Date.now(), html: "post", revalidate: 60 });

    const app = new Elysia().use(furinInvalidate()).delete("/posts/1", () => ({ ok: true }), {
      invalidate: { path: "/blog/post", type: "page" },
    });

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/posts/1", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/blog/post")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/blog/post");
  });
});
