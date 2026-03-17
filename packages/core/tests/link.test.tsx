import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeRoute } from "../src/client";
import type {
  CacheEntry,
  LinkProps,
  LoadedClientRoute,
  PreloadStrategy,
  RouterContextValue,
  RouterProviderProps,
} from "../src/link";
import { applyRevalidateHeader, buildHref, buildPageElement, Link, shouldRefetch } from "../src/link";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoute(opts: Partial<Omit<RuntimeRoute, "__type">> = {}): RuntimeRoute {
  return { __type: "FURIN_ROUTE", ...opts };
}

function makeMatch(
  component: React.FC<Record<string, unknown>>,
  pageRoute: RuntimeRoute,
  pattern = "/"
): LoadedClientRoute {
  return {
    component,
    pageRoute,
    pattern,
    regex: new RegExp(`^${pattern}$`),
    load: () => Promise.resolve({ default: { component, _route: pageRoute } }),
  };
}

function makeCacheEntry(msSinceCreated: number): CacheEntry {
  return { createdAt: Date.now() - msSinceCreated, promise: Promise.resolve(null) };
}

// ── shouldRefetch ──────────────────────────────────────────────────────────────

describe("shouldRefetch", () => {
  test("returns false when entry is fresh", () => {
    expect(shouldRefetch(makeCacheEntry(100), 1000)).toBe(false);
  });

  test("returns true when entry has expired", () => {
    expect(shouldRefetch(makeCacheEntry(2000), 1000)).toBe(true);
  });

  test("returns true at the exact staleTime boundary (strictly greater-than)", () => {
    expect(shouldRefetch(makeCacheEntry(1001), 1000)).toBe(true);
  });

  test("staleTime=0 — fresh entry does not force refetch (elapsed ≈ 0, not > 0)", () => {
    expect(shouldRefetch(makeCacheEntry(0), 0)).toBe(false);
  });

  test("very large staleTime — never refetches", () => {
    expect(shouldRefetch(makeCacheEntry(999), Number.MAX_SAFE_INTEGER)).toBe(false);
  });
});

// ── buildHref ─────────────────────────────────────────────────────────────────

describe("buildHref", () => {
  test("no search or hash — returns the pathname as-is", () => {
    expect(buildHref("/blog")).toBe("/blog");
  });

  test("search with a single key — appends query string", () => {
    expect(buildHref("/blog", { page: 2 })).toBe("/blog?page=2");
  });

  test("search with multiple keys — appends all non-null values", () => {
    const result = buildHref("/blog", { page: 1, tag: "react" });
    expect(result).toContain("page=1");
    expect(result).toContain("tag=react");
    expect(result.startsWith("/blog?")).toBe(true);
  });

  test("null/undefined search values are omitted", () => {
    expect(buildHref("/blog", { page: 1, tag: null })).toBe("/blog?page=1");
    expect(buildHref("/blog", { page: 1, tag: undefined })).toBe("/blog?page=1");
  });

  test("empty search object — no query string appended", () => {
    expect(buildHref("/blog", {})).toBe("/blog");
  });

  test("null search — no query string appended", () => {
    expect(buildHref("/blog", null)).toBe("/blog");
  });

  test("hash only — appends fragment", () => {
    expect(buildHref("/about", undefined, "section")).toBe("/about#section");
  });

  test("search and hash together", () => {
    expect(buildHref("/blog", { page: 2 }, "top")).toBe("/blog?page=2#top");
  });

  test("boolean search value — stringified", () => {
    expect(buildHref("/search", { active: true })).toBe("/search?active=true");
  });
});

// ── buildPageElement ──────────────────────────────────────────────────────────

describe("buildPageElement", () => {
  const data = { title: "test" };

  const Page: React.FC<Record<string, unknown>> = () => createElement("p", null, "page");

  test("no layout — returns the page element directly", () => {
    const match = makeMatch(Page, makeRoute());
    expect(renderToStaticMarkup(buildPageElement(match, null, data))).toBe("<p>page</p>");
  });

  test("one layout in pageRoute (no root) — wraps the page", () => {
    const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("main", null, children);

    const match = makeMatch(Page, makeRoute({ layout: Layout }));
    expect(renderToStaticMarkup(buildPageElement(match, null, data))).toBe(
      "<main><p>page</p></main>"
    );
  });

  test("root layout only (no nested layout) — root wraps the page", () => {
    const Root: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("body", null, children);

    const root = makeRoute({ layout: Root });
    const match = makeMatch(Page, makeRoute()); // pageRoute has no layout
    expect(renderToStaticMarkup(buildPageElement(match, root, data))).toBe(
      "<body><p>page</p></body>"
    );
  });

  test("root + nested layout — root wraps nested which wraps page", () => {
    const Root: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("section", { "data-root": true }, children);
    const Nav: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("nav", null, children);

    const rootRoute = makeRoute({ layout: Root });
    const pageRoute = makeRoute({ layout: Nav, parent: rootRoute });
    const match = makeMatch(Page, pageRoute, "/dashboard");

    expect(renderToStaticMarkup(buildPageElement(match, rootRoute, data))).toBe(
      '<section data-root="true"><nav><p>page</p></nav></section>'
    );
  });

  test("passes loader data to the page component as props", () => {
    const DataPage: React.FC<Record<string, unknown>> = ({ title }) =>
      createElement("h1", null, String(title));

    const match = makeMatch(DataPage, makeRoute());
    expect(renderToStaticMarkup(buildPageElement(match, null, { title: "Hello World" }))).toBe(
      "<h1>Hello World</h1>"
    );
  });

  test("passes loader data to layout components as props", () => {
    const Layout: React.FC<Record<string, unknown>> = ({ title, children }) =>
      createElement("div", { "data-title": String(title) }, children as React.ReactNode);

    const match = makeMatch(Page, makeRoute({ layout: Layout }));
    expect(renderToStaticMarkup(buildPageElement(match, null, { title: "My Blog" }))).toBe(
      '<div data-title="My Blog"><p>page</p></div>'
    );
  });
});

// ── Link ──────────────────────────────────────────────────────────────────────

describe("Link", () => {
  test("renders an <a> tag with the given to path", () => {
    const html = renderToStaticMarkup(createElement(Link, { to: "/blog" }, "Blog"));
    expect(html).toBe('<a href="/blog">Blog</a>');
  });

  test("passes through className", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { to: "/about", className: "nav-link" }, "About")
    );
    expect(html).toContain('class="nav-link"');
    expect(html).toContain('href="/about"');
  });

  test("passes through aria attributes", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { to: "/", "aria-label": "Home page" }, "Home")
    );
    expect(html).toContain('aria-label="Home page"');
  });

  test("renders nested element children", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { to: "/" }, createElement("span", null, "→"), " Home")
    );
    expect(html).toContain("<span>→</span>");
    expect(html).toContain('href="/"');
  });

  test("external href — rendered as a normal anchor", () => {
    const html = renderToStaticMarkup(
      // Cast because RouteManifest is unaugmented here; external URLs are still valid at runtime
      createElement(Link, { to: "https://example.com" as string }, "External")
    );
    expect(html).toBe('<a href="https://example.com">External</a>');
  });

  test("renders without children", () => {
    const html = renderToStaticMarkup(createElement(Link, { to: "/empty" as string }));
    expect(html).toBe('<a href="/empty"></a>');
  });

  test("search params are serialized into the href", () => {
    const html = renderToStaticMarkup(
      // Cast to string since RouteManifest is unaugmented in tests
      createElement(Link, { to: "/blog" as string, search: { page: 2 } }, "Next")
    );
    expect(html).toBe('<a href="/blog?page=2">Next</a>');
  });

  test("hash is appended to the href", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { to: "/about" as string, hash: "team" }, "Team")
    );
    expect(html).toBe('<a href="/about#team">Team</a>');
  });
});

// ── Types ──────────────────────────────────────────────────────────────────────

describe("types", () => {
  test("PreloadStrategy is the correct union", () => {
    expectTypeOf<PreloadStrategy>().toEqualTypeOf<false | "intent" | "viewport" | "render">();
  });

  test("RouterContextValue has the expected fields", () => {
    expectTypeOf<RouterContextValue["navigate"]>().toBeFunction();
    expectTypeOf<RouterContextValue["prefetch"]>().toBeFunction();
    expectTypeOf<RouterContextValue["isNavigating"]>().toEqualTypeOf<boolean>();
    expectTypeOf<RouterContextValue["defaultPreload"]>().toEqualTypeOf<PreloadStrategy>();
    expectTypeOf<RouterContextValue["defaultPreloadDelay"]>().toEqualTypeOf<number>();
    expectTypeOf<RouterContextValue["defaultPreloadStaleTime"]>().toEqualTypeOf<number>();
  });

  test("LinkProps.preload is an optional PreloadStrategy", () => {
    expectTypeOf<LinkProps["preload"]>().toEqualTypeOf<PreloadStrategy | undefined>();
  });

  test("LinkProps.preloadDelay and preloadStaleTime are optional numbers", () => {
    expectTypeOf<LinkProps["preloadDelay"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LinkProps["preloadStaleTime"]>().toEqualTypeOf<number | undefined>();
  });

  test("LinkProps.to is a string (RouteTo fallback when RouteManifest is unaugmented)", () => {
    expectTypeOf<LinkProps["to"]>().toBeString();
  });

  test("RouterProviderProps.prefetchCacheSize is an optional number", () => {
    expectTypeOf<RouterProviderProps["prefetchCacheSize"]>().toEqualTypeOf<number | undefined>();
  });
});

// ── prefetch cache LRU eviction ────────────────────────────────────────────────

describe("prefetch cache LRU eviction", () => {
  function simulateCache(cap: number, hrefs: string[]): Map<string, number> {
    const cache = new Map<string, number>();
    for (const href of hrefs) {
      cache.set(href, Date.now());
      if (cache.size > cap) {
        const oldest = cache.keys().next().value as string;
        cache.delete(oldest);
      }
    }
    return cache;
  }

  test("cache stays within cap as entries are added", () => {
    const cache = simulateCache(3, ["/a", "/b", "/c", "/d"]);
    expect(cache.size).toBe(3);
  });

  test("oldest entry is evicted when cap is exceeded", () => {
    const cache = simulateCache(3, ["/a", "/b", "/c", "/d"]);
    expect(cache.has("/a")).toBe(false); // evicted
    expect(cache.has("/d")).toBe(true); // newest kept
  });

  test("cap of 1 keeps only the latest entry", () => {
    const cache = simulateCache(1, ["/a", "/b", "/c"]);
    expect(cache.size).toBe(1);
    expect(cache.has("/c")).toBe(true);
  });

  test("no eviction when entries stay within cap", () => {
    const cache = simulateCache(5, ["/a", "/b", "/c"]);
    expect(cache.size).toBe(3);
    expect(cache.has("/a")).toBe(true);
    expect(cache.has("/b")).toBe(true);
    expect(cache.has("/c")).toBe(true);
  });

  test("re-setting an existing href does not change insertion order — original position is evicted", () => {
    const cache = simulateCache(2, ["/a", "/b", "/a", "/c"]);
    // Map.set() on an existing key updates value but keeps insertion order.
    // /a was inserted first, so it remains the oldest and is evicted when /c is added.
    expect(cache.has("/a")).toBe(false); // evicted — still oldest despite being re-set
    expect(cache.has("/b")).toBe(true);
    expect(cache.has("/c")).toBe(true);
  });
});

// ── applyRevalidateHeader ──────────────────────────────────────────────────────

describe("applyRevalidateHeader", () => {
  function makeHeaders(value?: string): Headers {
    const h = new Headers();
    if (value !== undefined) h.set("x-furin-revalidate", value);
    return h;
  }

  test("does nothing when header is absent", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders(), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([]);
  });

  test("calls invalidate for a single page path", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/blog/post-1"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/blog/post-1", "page"]]);
  });

  test("calls invalidate with 'layout' type when entry ends with :layout", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/blog:layout"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/blog", "layout"]]);
  });

  test("handles multiple comma-separated entries", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/a,/b,/c"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/a", "page"], ["/b", "page"], ["/c", "page"]]);
  });

  test("handles mixed page and layout entries", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/blog/post-1,/blog:layout"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/blog/post-1", "page"], ["/blog", "layout"]]);
  });
});

// ── invalidatePrefetch logic ───────────────────────────────────────────────────

describe("invalidatePrefetch — page type", () => {
  function makeCache(keys: string[]): Map<string, unknown> {
    return new Map(keys.map((k) => [k, {}]));
  }

  function runInvalidate(cache: Map<string, unknown>, path: string, type: "page" | "layout" = "page") {
    if (type === "page") {
      cache.delete(path);
      return;
    }
    const prefix = path === "/" ? "/" : path.endsWith("/") ? path : `${path}/`;
    for (const key of cache.keys()) {
      try {
        const pathname = new URL(key, "http://x").pathname;
        if (pathname === path || pathname.startsWith(prefix)) cache.delete(key);
      } catch {
        if (key === path || key.startsWith(prefix)) cache.delete(key);
      }
    }
  }

  test("removes exact key from cache", () => {
    const cache = makeCache(["/blog/post-1", "/blog/post-2"]);
    runInvalidate(cache, "/blog/post-1", "page");
    expect(cache.has("/blog/post-1")).toBe(false);
    expect(cache.has("/blog/post-2")).toBe(true);
  });

  test("does not remove other keys", () => {
    const cache = makeCache(["/a", "/b", "/c"]);
    runInvalidate(cache, "/b", "page");
    expect(cache.has("/a")).toBe(true);
    expect(cache.has("/c")).toBe(true);
    expect(cache.size).toBe(2);
  });
});

describe("invalidatePrefetch — layout type", () => {
  function makeCache(keys: string[]): Map<string, unknown> {
    return new Map(keys.map((k) => [k, {}]));
  }

  function runInvalidateLayout(cache: Map<string, unknown>, path: string) {
    const prefix = path === "/" ? "/" : path.endsWith("/") ? path : `${path}/`;
    for (const key of cache.keys()) {
      try {
        const pathname = new URL(key, "http://x").pathname;
        if (pathname === path || pathname.startsWith(prefix)) cache.delete(key);
      } catch {
        if (key === path || key.startsWith(prefix)) cache.delete(key);
      }
    }
  }

  test("removes the path itself", () => {
    const cache = makeCache(["/blog", "/blog/post-1"]);
    runInvalidateLayout(cache, "/blog");
    expect(cache.has("/blog")).toBe(false);
  });

  test("removes all nested paths under the prefix", () => {
    const cache = makeCache(["/blog/post-1", "/blog/post-2", "/about"]);
    runInvalidateLayout(cache, "/blog");
    expect(cache.has("/blog/post-1")).toBe(false);
    expect(cache.has("/blog/post-2")).toBe(false);
    expect(cache.has("/about")).toBe(true);
  });

  test("does not remove unrelated paths", () => {
    const cache = makeCache(["/blog/post-1", "/blogging", "/other"]);
    runInvalidateLayout(cache, "/blog");
    // /blogging does NOT start with /blog/ — should survive
    expect(cache.has("/blogging")).toBe(true);
    expect(cache.has("/other")).toBe(true);
    expect(cache.has("/blog/post-1")).toBe(false);
  });

  test("handles root '/' — removes all cached paths", () => {
    const cache = makeCache(["/", "/about", "/blog/post-1"]);
    runInvalidateLayout(cache, "/");
    expect(cache.size).toBe(0);
  });
});
