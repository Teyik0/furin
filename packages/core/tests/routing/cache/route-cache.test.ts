import { describe, expect, test } from "bun:test";

import { createRouteCache } from "../../../src/server/cache/route-cache.ts";

describe("createRouteCache", () => {
  test("invalidates a single page by resolved URL path", () => {
    const cache = createRouteCache<{ html: string }>({ name: "test" });
    cache.set("/blog/post", { html: "post" });
    cache.set("/blog/other", { html: "other" });

    const result = cache.invalidatePath("/blog/post", "page");

    expect(result).toEqual({ deleted: true, purgedPaths: ["/blog/post"] });
    expect(cache.get("/blog/post")).toBeUndefined();
    expect(cache.get("/blog/other")).toEqual({ html: "other" });
  });

  test("uses a custom key resolver and runs delete hooks on path invalidation", () => {
    const deleted: Array<{ key: string; html: string }> = [];
    const cache = createRouteCache<{ html: string }>({
      name: "dev",
      onDelete: (cacheKey, entry) => {
        deleted.push({ html: entry.html, key: cacheKey });
      },
      pathFromKey: (cacheKey) => {
        const sep = cacheKey.lastIndexOf(":/");
        return sep === -1 ? null : cacheKey.slice(sep + 1);
      },
    });
    const root = "C:/Users/me/app/src/pages";
    const key = `${root}:/blog/post`;
    cache.set(key, { html: "post" });
    cache.set(`${root}:/other`, { html: "other" });

    const result = cache.invalidatePath("/blog/post", "page");

    expect(result).toEqual({ deleted: true, purgedPaths: ["/blog/post"] });
    expect(cache.get(key)).toBeUndefined();
    expect(cache.get(`${root}:/other`)).toEqual({ html: "other" });
    expect(deleted).toEqual([{ html: "post", key }]);
  });

  test("invalidates all query variants for a resolved URL path", () => {
    const cache = createRouteCache<{ html: string }>({
      name: "query-variants",
      pathFromKey: (cacheKey) => {
        const url = new URL(`http://localhost${cacheKey}`);
        return url.pathname;
      },
    });
    cache.set("/search?tenant=a", { html: "a" });
    cache.set("/search?tenant=b", { html: "b" });
    cache.set("/profile?tenant=a", { html: "profile" });

    const result = cache.invalidatePath("/search", "page");

    expect(result).toEqual({ deleted: true, purgedPaths: ["/search"] });
    expect(cache.get("/search?tenant=a")).toBeUndefined();
    expect(cache.get("/search?tenant=b")).toBeUndefined();
    expect(cache.get("/profile?tenant=a")).toEqual({ html: "profile" });
  });

  test("applies LRU eviction and promotes entries on read", () => {
    const cache = createRouteCache<{ html: string }>({ maxSize: 2, name: "lru" });
    cache.set("/a", { html: "a" });
    cache.set("/b", { html: "b" });

    expect(cache.get("/a")).toEqual({ html: "a" });
    cache.set("/c", { html: "c" });

    expect(cache.has("/a")).toBe(true);
    expect(cache.has("/b")).toBe(false);
    expect(cache.has("/c")).toBe(true);
    expect(cache.size).toBe(2);
  });
});
