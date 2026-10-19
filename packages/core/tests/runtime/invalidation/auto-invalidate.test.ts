import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { applyRevalidateHeader } from "../../../src/client/router/link-utils.ts";
import {
  autoInvalidateRegistry,
  furinInvalidate,
  revalidateTag,
} from "../../../src/server/auto-invalidate/index.ts";
import {
  AutoInvalidateRegistry,
  getAutoInvalidateRegistry,
} from "../../../src/server/auto-invalidate/registry.ts";
import {
  __resetCacheState,
  __resetDevLoaderCacheState,
  _runWithRequestInvalidationScope,
  consumePendingInvalidations,
  getDevISRLoaderCache,
  getDevSSGLoaderCache,
  isrCache,
  revalidatePath,
  setDevISRLoaderCache,
  setDevSSGLoaderCache,
  setISRCache,
  setSSGCache,
  ssgCache,
} from "../../../src/server/cache/index.ts";
import { setInstanceCachePurger } from "../../../src/server/cache/purger.ts";
import {
  __clearInstanceRegistry,
  allInstances,
  createInstance,
  registerInstance,
  withInstance,
} from "../../../src/server/instance.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures";
import { flushMicrotasks } from "../../support/microtasks";

const { furin } = await import("../../../src/furin.ts");

afterEach(async () => {
  __resetCacheState();
  __clearInstanceRegistry();
  __resetDevLoaderCacheState();
  autoInvalidateRegistry.reset();
  await flushMicrotasks();
});

test("mutation invalidation headers preserve literal suffixes, percent paths and Unicode", async () => {
  const rules = [
    { path: "/foo:layout", type: "page" as const },
    { path: "/東京", type: "layout" as const },
    { path: "/users/a%name", type: "page" as const },
    { path: "/bad\ud800", type: "page" as const },
  ];
  const app = new Elysia()
    .use(furinInvalidate())
    .post("/mutate", { invalidate: rules }, () => ({ ok: true }));
  const response = await _runWithRequestInvalidationScope(() =>
    app.handle(new Request("http://localhost/mutate", { method: "POST" }))
  );
  expect(response.status).toBe(200);
  const received: { path: string; type: "page" | "layout" | undefined }[] = [];
  applyRevalidateHeader(response.headers, (path, type) => received.push({ path, type }));
  expect(received).toEqual(rules.map((rule) => ({ ...rule, path: rule.path.toWellFormed() })));
});

describe("revalidateTag", () => {
  test("keeps a tag path while another cache still owns it", () => {
    const registry = new AutoInvalidateRegistry();
    registry.registerLoaderTags("/catalog", ["catalog"], "render:isr-html");
    registry.registerLoaderTags("/catalog", ["catalog"], "render:mixed-public-loader");

    registry.unregisterPath("/catalog", "render:mixed-public-loader");

    expect(registry.pathsForTags(["catalog"])).toEqual(["/catalog"]);
  });

  test("invalidates every production cache path registered under a tag", async () => {
    setISRCache("/board/123", {
      generatedAt: Date.now(),
      html: "board",
      ndjson: "{}\n",
      revalidate: 60,
    });
    setSSGCache("/", { cachedAt: Date.now(), html: "home", ndjson: "{}\n", status: 200 });
    setISRCache("/untagged", {
      generatedAt: Date.now(),
      html: "other",
      ndjson: "{}\n",
      revalidate: 60,
    });

    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const deleted = await revalidateTag("board");

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

    const deleted = await revalidateTag(["board", "boards"]);

    expect(deleted).toBe(true);
    expect(getDevISRLoaderCache("/repo/src/pages/root.tsx:/board/123")).toBeUndefined();
    expect(getDevSSGLoaderCache("/repo/src/pages/root.tsx:/")).toBeUndefined();
    await flushMicrotasks();
  });

  test("unregisters tag mappings when cached paths are evicted", async () => {
    setISRCache("/board/123", {
      generatedAt: Date.now(),
      html: "board",
      ndjson: "{}\n",
      revalidate: 60,
    });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    await revalidateTag("board");
    const second = await revalidateTag("board");

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
      setISRCache("/x", { generatedAt: Date.now(), html: "a:x", ndjson: "{}\n", revalidate: 60 });
      autoInvalidateRegistry.registerLoaderTags("/x", ["shared"]);
    });
    withInstance(b, () => {
      setISRCache("/x", { generatedAt: Date.now(), html: "b:x", ndjson: "{}\n", revalidate: 60 });
    });

    const deleted = await revalidateTag("shared");

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
    setInstanceCachePurger(admin, (paths) => {
      purged.push(paths);
      return Promise.resolve();
    });

    withInstance(admin, () => {
      setISRCache("/x", {
        generatedAt: Date.now(),
        html: "admin:x",
        ndjson: "{}\n",
        revalidate: 60,
      });
      autoInvalidateRegistry.registerLoaderTags("/x", ["shared"]);
    });

    await revalidateTag("shared");
    await flushMicrotasks();

    expect(purged.flat()).toContain("/admin/x");
    expect(purged.flat()).not.toContain("/x");
    expect(purged.flat()).not.toContain("shared");
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
      setISRCache("/x", { generatedAt: Date.now(), html: "a:x", ndjson: "{}\n", revalidate: 60 });
      setDevISRLoaderCache("/apps/a/src/pages/root.tsx:/y", {
        dependencies: [],
        generatedAt: Date.now(),
        headers: {},
        loaderData: {},
        mode: "isr",
        revalidate: 60,
      });
      autoInvalidateRegistry.registerLoaderTags("/x", ["shared"], "render:isr-html");
      autoInvalidateRegistry.registerLoaderTags("/y", ["shared"], "render:dev-isr-loader");
    });

    __resetCacheState();

    expect(withInstance(a, () => autoInvalidateRegistry.pathsForTags(["shared"]))).toEqual([]);
    await flushMicrotasks();
  });
});

describe("revalidatePath", () => {
  test("uses the same mounted root key as the deployment adapter", async () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    const purged: string[] = [];
    setInstanceCachePurger(admin, (paths) => {
      purged.push(...paths);
      return Promise.resolve();
    });
    await revalidatePath("/", "page");
    await flushMicrotasks();
    expect(purged).toContain("/admin");
    expect(purged).not.toContain("/admin/");
  });

  test("does not propagate a synchronous purge failure", async () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    setInstanceCachePurger(admin, () => {
      throw new Error("Purge unavailable");
    });
    await expect(revalidatePath("/x", "page")).resolves.toBe(false);
    await flushMicrotasks();
  });

  test("purges the mounted app's PHYSICAL (prefixed) URL, not the logical path", async () => {
    const admin = registerInstance(createInstance("/admin", "/apps/admin"));
    const purged: string[][] = [];
    setInstanceCachePurger(admin, (paths) => {
      purged.push(paths);
      return Promise.resolve();
    });

    withInstance(admin, () => {
      setISRCache("/x", {
        generatedAt: Date.now(),
        html: "admin:x",
        ndjson: "{}\n",
        revalidate: 60,
      });
    });

    const deleted = await revalidatePath("/x", "page");
    await flushMicrotasks();

    expect(deleted).toBe(true);
    expect(withInstance(admin, () => isrCache.has("/x"))).toBe(false);
    expect(purged.flat()).toContain("/admin/x");
    expect(purged.flat()).not.toContain("/x");
  });
});

describe("furinInvalidate macro", () => {
  test("a standalone app reports each request's own invalidations", async () => {
    const app = new Elysia()
      .use(furinInvalidate())
      .post("/a", { invalidate: { path: "/a", type: "page" } }, () => ({ ok: true }))
      .post("/b", { invalidate: { path: "/b", type: "page" } }, () => ({ ok: true }));

    const [a, b] = await Promise.all(
      ["/a", "/b"].map((path) =>
        app.handle(new Request(`http://localhost${path}`, { method: "POST" }))
      )
    );

    expect(a?.headers.get("x-furin-revalidate")).toBe("/a");
    expect(b?.headers.get("x-furin-revalidate")).toBe("/b");
  });

  test("runs invalidation rules on successful mutation responses", async () => {
    setISRCache("/board/123", {
      generatedAt: Date.now(),
      html: "board",
      ndjson: "{}\n",
      revalidate: 60,
    });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .post("/cards", { invalidate: { tags: ["board"] } }, () => ({ ok: true }));

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards", { method: "POST" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/board/123")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board/123");
    expect(consumePendingInvalidations()).toEqual([]);
  });

  test("does not invalidate failed mutation responses", async () => {
    setISRCache("/board/123", {
      generatedAt: Date.now(),
      html: "board",
      ndjson: "{}\n",
      revalidate: 60,
    });
    autoInvalidateRegistry.registerLoaderTags("/board/123", ["board"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .post("/cards", { invalidate: { tags: ["board"] } }, ({ status }) =>
        status("Bad Request", "bad")
      );

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/cards", { method: "POST" }))
    );

    expect(response.status).toBe(400);
    expect(isrCache.has("/board/123")).toBe(true);
    expect(response.headers.get("x-furin-revalidate")).toBeNull();
  });

  test("development navigation data keeps tagged paths only while their loader output is cached", async () => {
    const tmpApp = createTmpApp("cli-app");
    writeAppFile(
      tmpApp.path,
      "src/pages/items/[id].tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        'import { route as rootRoute } from "../root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "isr", revalidate: 60, tags: ["boards"],',
        "    params: t.Object({ id: t.String() }) })",
        '  .loader(() => ({ pageData: "from-page" }))',
        "  .page(({ pageData }) => <main>{pageData}</main>);",
      ].join("\n")
    );
    const originalCwd = process.cwd();
    __setDevMode(true);
    process.chdir(tmpApp.path);
    try {
      const pagesDir = join(tmpApp.path, "src/pages");
      const app = new Elysia().use(await furin({ pagesDir }));
      const instance = allInstances().find((candidate) => candidate.pagesDir === pagesDir);
      for (let index = 0; index < 200; index += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: requests verify cardinality across paths.
        const response = await app.handle(
          new Request(`http://localhost/items/${index}?_furin=data`)
        );
        expect(response.status).toBe(200);
      }

      // Navigation data fills the dev loader cache, whose entries own the tags.
      expect(getAutoInvalidateRegistry(instance).pathsForTags(["boards"])).toHaveLength(200);
      __resetDevLoaderCacheState();
      expect(getAutoInvalidateRegistry(instance).pathsForTags(["boards"])).toEqual([]);
    } finally {
      process.chdir(originalCwd);
      __resetCompileContext();
      tmpApp.cleanup();
    }
  });

  test("two plugins both calling furinInvalidate() + DELETE → header still set (task-manager replica)", async () => {
    // The real task-manager has both boardPlugin and cardPlugin each call
    // `.use(furinInvalidate())`. Both Elysia instances share the same plugin
    // name `furin-invalidate`. This test verifies the second plugin still
    // sees the macro applied to its DELETE route.
    setISRCache("/", { generatedAt: Date.now(), html: "home", ndjson: "{}\n", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const boardPlugin = new Elysia()
      .use(furinInvalidate())
      .post("/boards", { invalidate: { tags: ["boards"] } }, () => ({ id: "x" }))
      .delete("/boards/:id", { invalidate: { tags: ["boards"] } }, () => ({ ok: true }));

    const cardPlugin = new Elysia()
      .use(furinInvalidate())
      .post("/cards", { invalidate: { tags: ["cards"] } }, () => ({ ok: true }));

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
    setISRCache("/", { generatedAt: Date.now(), html: "home", ndjson: "{}\n", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const inner = new Elysia()
      .use(furinInvalidate())
      .delete("/boards/:id", { invalidate: { tags: ["boards"] } }, () => ({ ok: true }));

    const api = new Elysia({ prefix: "/api" }).use(inner);

    // Mirror `wrapWithRequestScope`: app.wrap(...) — installs the AsyncLocalStorage
    // scope around the composed handler instead of using the test helper.
    const wrapped = new Elysia().use(api).wrap(
      (fetch) =>
        (request, ...rest) =>
          _runWithRequestInvalidationScope(() => fetch(request, ...rest))
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
    setISRCache("/", { generatedAt: Date.now(), html: "home", ndjson: "{}\n", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const boardPlugin = new Elysia()
      .use(furinInvalidate())
      .get("/boards", () => ({ list: [] }))
      .post("/boards", { invalidate: { tags: ["boards"] } }, () => ({ id: "new" }))
      .delete("/boards/:boardId", { invalidate: { tags: ["boards"] } }, () => ({ ok: true }))
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
    setISRCache("/", { generatedAt: Date.now(), html: "home", ndjson: "{}\n", revalidate: 10 });
    autoInvalidateRegistry.registerLoaderTags("/", ["boards"]);

    const app = new Elysia()
      .use(furinInvalidate())
      .delete("/boards/:id", { invalidate: { tags: ["boards"] } }, () => ({ ok: true }));

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/boards/abc", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/");
  });

  test("supports path-based invalidation rules", async () => {
    setISRCache("/blog/post", {
      generatedAt: Date.now(),
      html: "post",
      ndjson: "{}\n",
      revalidate: 60,
    });

    const app = new Elysia()
      .use(furinInvalidate())
      .delete("/posts/1", { invalidate: { path: "/blog/post", type: "page" } }, () => ({
        ok: true,
      }));

    const response = await _runWithRequestInvalidationScope(() =>
      app.handle(new Request("http://localhost/posts/1", { method: "DELETE" }))
    );

    expect(response.status).toBe(200);
    expect(isrCache.has("/blog/post")).toBe(false);
    expect(response.headers.get("x-furin-revalidate")).toBe("/blog/post");
  });
});
