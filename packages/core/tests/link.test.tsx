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
  RouteTo,
} from "../src/link";
import {
  applyRevalidateHeader,
  buildHref,
  buildPageElement,
  Link,
  RouterContext,
  shouldAutoRefreshPath,
  shouldRefetch,
} from "../src/link";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRouterContext(overrides: Partial<RouterContextValue> = {}): RouterContextValue {
  return {
    basePath: "",
    currentHref: "/",
    navigate: () => Promise.resolve(),
    prefetch: () => {
      /* noop */
    },
    invalidatePrefetch: () => {
      /* noop */
    },
    refresh: () => Promise.resolve(),
    isNavigating: false,
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    ...overrides,
  };
}

function renderWithRouter(element: React.ReactElement, ctx: RouterContextValue): string {
  return renderToStaticMarkup(createElement(RouterContext.Provider, { value: ctx }, element));
}

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

function makeCacheEntry(msSinceCreated: number, staleTime: number): CacheEntry {
  return { createdAt: Date.now() - msSinceCreated, promise: Promise.resolve(null), staleTime };
}

// ── shouldRefetch ──────────────────────────────────────────────────────────────

describe("shouldRefetch", () => {
  test("returns false when entry is fresh", () => {
    expect(shouldRefetch(makeCacheEntry(100, 1000))).toBe(false);
  });

  test("returns true when entry has expired", () => {
    expect(shouldRefetch(makeCacheEntry(2000, 1000))).toBe(true);
  });

  test("returns true at the exact staleTime boundary (strictly greater-than)", () => {
    expect(shouldRefetch(makeCacheEntry(1001, 1000))).toBe(true);
  });

  test("staleTime=0 — fresh entry does not force refetch (elapsed ≈ 0, not > 0)", () => {
    expect(shouldRefetch(makeCacheEntry(0, 0))).toBe(false);
  });

  test("very large staleTime — never refetches", () => {
    expect(shouldRefetch(makeCacheEntry(999, Number.MAX_SAFE_INTEGER))).toBe(false);
  });

  test("uses the staleTime stored on the cache entry", () => {
    expect(shouldRefetch(makeCacheEntry(200, 100))).toBe(true);
    expect(shouldRefetch(makeCacheEntry(200, 1000))).toBe(false);
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

  test("data-status='active' when to matches the fallback currentHref '/'", () => {
    // Outside RouterProvider, currentHref fallback = "/" (window is undefined in SSR/tests)
    const html = renderToStaticMarkup(createElement(Link, { to: "/" as string }, "Home"));
    expect(html).toContain('data-status="active"');
  });

  test("no data-status attribute when link is inactive", () => {
    const html = renderToStaticMarkup(createElement(Link, { to: "/blog" as string }, "Blog"));
    expect(html).not.toContain("data-status");
  });

  test("children as render function — receives isActive=false outside RouterProvider", () => {
    // Function-children must be passed via the props object because createElement's rest-arg
    // children parameter is typed as ReactNode (not a function). biome-ignore is needed here.
    const html = renderToStaticMarkup(
      createElement(Link, {
        to: "/blog" as string,
        // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
        children: ({ isActive }: { isActive: boolean }) =>
          createElement("span", { "data-active": String(isActive) }, "Blog"),
      })
    );
    expect(html).toContain('data-active="false"');
    expect(html).toContain("<span");
  });

  test("children as render function — receives isActive=true when to='/'", () => {
    const html = renderToStaticMarkup(
      createElement(Link, {
        to: "/" as string,
        // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
        children: ({ isActive }: { isActive: boolean }) =>
          createElement("span", { "data-active": String(isActive) }, "Home"),
      })
    );
    expect(html).toContain('data-active="true"');
  });

  test("activeProps — merges className when link is active (to='/')", () => {
    const html = renderToStaticMarkup(
      createElement(
        Link,
        {
          to: "/" as string,
          activeProps: ({ isActive }) => (isActive ? { className: "active-link" } : {}),
        },
        "Home"
      )
    );
    expect(html).toContain('class="active-link"');
    expect(html).toContain('data-status="active"');
  });

  test("inactiveProps — merges className when link is inactive", () => {
    const html = renderToStaticMarkup(
      createElement(
        Link,
        {
          to: "/blog" as string,
          inactiveProps: () => ({ className: "muted-link" }),
        },
        "Blog"
      )
    );
    expect(html).toContain('class="muted-link"');
    expect(html).not.toContain("data-status");
  });

  test("disabled — renders aria-disabled and keeps href", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { to: "/about" as string, disabled: true }, "About")
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain('href="/about"');
  });

  // ── B10: basePath — href uses physical path ───────────────────────────────────

  test("B10: renders href with basePath prefix when router has basePath", () => {
    const ctx = makeRouterContext({ basePath: "/furin", currentHref: "/" });
    const html = renderWithRouter(createElement(Link, { to: "/docs" as RouteTo }, "Docs"), ctx);
    // physical href = basePath + logical path
    expect(html).toContain('href="/furin/docs"');
  });

  // ── B11: basePath — active state uses logical path ────────────────────────────

  test("B11: link is active when currentHref matches logical path (basePath stripped)", () => {
    // currentHref="/docs" is the logical path — Link to="/docs" should be active
    const ctx = makeRouterContext({ basePath: "/furin", currentHref: "/docs" });
    const html = renderWithRouter(createElement(Link, { to: "/docs" as RouteTo }, "Docs"), ctx);
    expect(html).toContain('data-status="active"');
    // Href is still physical
    expect(html).toContain('href="/furin/docs"');
  });

  test("B11b: link is NOT active when currentHref is a different logical path", () => {
    const ctx = makeRouterContext({ basePath: "/furin", currentHref: "/other" });
    const html = renderWithRouter(createElement(Link, { to: "/docs" as RouteTo }, "Docs"), ctx);
    expect(html).not.toContain("data-status");
    expect(html).toContain('href="/furin/docs"');
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
    expectTypeOf<RouterContextValue["refresh"]>().toBeFunction();
    expectTypeOf<RouterContextValue["isNavigating"]>().toEqualTypeOf<boolean>();
    expectTypeOf<RouterContextValue["defaultPreload"]>().toEqualTypeOf<PreloadStrategy>();
    expectTypeOf<RouterContextValue["defaultPreloadDelay"]>().toEqualTypeOf<number>();
    expectTypeOf<RouterContextValue["defaultPreloadStaleTime"]>().toEqualTypeOf<number>();
    expectTypeOf<RouterContextValue["currentHref"]>().toEqualTypeOf<string>();
  });

  test("RouterContextValue.refresh returns Promise<void> and accepts optional resetScroll", () => {
    expectTypeOf<RouterContextValue["refresh"]>().toBeCallableWith();
    expectTypeOf<RouterContextValue["refresh"]>().toBeCallableWith({ resetScroll: true });
    expectTypeOf<RouterContextValue["refresh"]>().toBeCallableWith({ resetScroll: false });
    expectTypeOf<ReturnType<RouterContextValue["refresh"]>>().toEqualTypeOf<Promise<void>>();
  });

  test("RouterProviderProps.autoRefresh is an optional boolean", () => {
    expectTypeOf<RouterProviderProps["autoRefresh"]>().toEqualTypeOf<boolean | undefined>();
  });

  test("LinkProps.preload is an optional PreloadStrategy", () => {
    expectTypeOf<LinkProps["preload"]>().toEqualTypeOf<PreloadStrategy | undefined>();
  });

  test("LinkProps.replace is an optional boolean", () => {
    expectTypeOf<LinkProps["replace"]>().toEqualTypeOf<boolean | undefined>();
  });

  test("LinkProps.resetScroll is an optional boolean", () => {
    expectTypeOf<LinkProps["resetScroll"]>().toEqualTypeOf<boolean | undefined>();
  });

  test("LinkProps.disabled is an optional boolean", () => {
    expectTypeOf<LinkProps["disabled"]>().toEqualTypeOf<boolean | undefined>();
  });

  test("LinkProps.activeProps is an optional function returning AnchorHTMLAttributes", () => {
    expectTypeOf<LinkProps["activeProps"]>().toEqualTypeOf<
      ((opts: { isActive: boolean }) => React.AnchorHTMLAttributes<HTMLAnchorElement>) | undefined
    >();
  });

  test("RouterContextValue.navigate accepts resetScroll option", () => {
    expectTypeOf<RouterContextValue["navigate"]>().toBeCallableWith("/", { resetScroll: true });
    expectTypeOf<RouterContextValue["navigate"]>().toBeCallableWith("/", { replace: true });
  });

  test("LinkProps.preloadDelay and preloadStaleTime are optional numbers", () => {
    expectTypeOf<LinkProps["preloadDelay"]>().toEqualTypeOf<number | undefined>();
    expectTypeOf<LinkProps["preloadStaleTime"]>().toEqualTypeOf<number | undefined>();
  });

  test("LinkProps.to is a string (RouteTo fallback when RouteManifest is unaugmented)", () => {
    expectTypeOf<LinkProps["to"]>().toBeString();
  });

  test("RouteTo includes https:// and http:// when RouteManifest is augmented", () => {
    // Simulate what RouteTo looks like when RouteManifest has routes
    // The actual type must accept external URLs alongside known routes
    type SimulatedRouteTo = "/" | "/blog" | `https://${string}` | `http://${string}`;
    expectTypeOf<"https://github.com">().toMatchTypeOf<SimulatedRouteTo>();
    expectTypeOf<"http://example.com">().toMatchTypeOf<SimulatedRouteTo>();
    // Internal routes still work
    expectTypeOf<"/">().toMatchTypeOf<SimulatedRouteTo>();
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
  // ── Bullet 13: parses page entries ─────────────────────────────────────────

  test("parses multiple page entries from header", () => {
    const calls: [string, string?][] = [];
    const headers = new Headers({ "x-furin-revalidate": "/blog/post,/home" });
    applyRevalidateHeader(headers, (path, type) => calls.push([path, type]));
    expect(calls).toEqual([
      ["/blog/post", "page"],
      ["/home", "page"],
    ]);
  });

  test("parses a single page entry", () => {
    const calls: [string, string?][] = [];
    const headers = new Headers({ "x-furin-revalidate": "/blog/post" });
    applyRevalidateHeader(headers, (path, type) => calls.push([path, type]));
    expect(calls).toEqual([["/blog/post", "page"]]);
  });

  test("page entries are called with type 'page'", () => {
    const types: (string | undefined)[] = [];
    const headers = new Headers({ "x-furin-revalidate": "/foo,/bar" });
    applyRevalidateHeader(headers, (_path, type) => types.push(type));
    expect(types).toEqual(["page", "page"]);
  });

  // ── Bullet 14: parses layout entries ───────────────────────────────────────

  test("parses layout entries from header", () => {
    const calls: [string, string?][] = [];
    const headers = new Headers({ "x-furin-revalidate": "/blog:layout" });
    applyRevalidateHeader(headers, (path, type) => calls.push([path, type]));
    expect(calls).toEqual([["/blog", "layout"]]);
  });

  test("layout entries strip the :layout suffix from the path", () => {
    const paths: string[] = [];
    const headers = new Headers({ "x-furin-revalidate": "/blog:layout" });
    applyRevalidateHeader(headers, (path) => paths.push(path));
    expect(paths).toEqual(["/blog"]);
  });

  test("layout entries are called with type 'layout'", () => {
    const types: (string | undefined)[] = [];
    const headers = new Headers({ "x-furin-revalidate": "/blog:layout" });
    applyRevalidateHeader(headers, (_path, type) => types.push(type));
    expect(types).toEqual(["layout"]);
  });

  test("mixed page and layout entries are parsed correctly", () => {
    const calls: [string, string?][] = [];
    const headers = new Headers({ "x-furin-revalidate": "/home,/blog:layout,/about" });
    applyRevalidateHeader(headers, (path, type) => calls.push([path, type]));
    expect(calls).toEqual([
      ["/home", "page"],
      ["/blog", "layout"],
      ["/about", "page"],
    ]);
  });

  // ── Bullet 15: no-op when header absent ────────────────────────────────────

  test("is a no-op when header is absent", () => {
    const headers = new Headers();
    applyRevalidateHeader(headers, () => {
      throw new Error("should not call");
    });
    // No throw = pass
  });

  test("is a no-op when header is empty string", () => {
    const headers = new Headers({ "x-furin-revalidate": "" });
    const calls: string[] = [];
    applyRevalidateHeader(headers, (path) => calls.push(path));
    expect(calls).toEqual([]);
  });

  test("handles whitespace around commas gracefully", () => {
    const calls: [string, string?][] = [];
    const headers = new Headers({ "x-furin-revalidate": "/foo , /bar" });
    applyRevalidateHeader(headers, (path, type) => calls.push([path, type]));
    // Trimming is applied per entry
    expect(calls).toEqual([
      ["/foo", "page"],
      ["/bar", "page"],
    ]);
  });
});

// ── shouldAutoRefreshPath ──────────────────────────────────────────────────────

describe("shouldAutoRefreshPath", () => {
  // ── page exact match ────────────────────────────────────────────────────────

  test("page: exact match on pathname → true", () => {
    expect(shouldAutoRefreshPath("/", [{ path: "/", type: "page" }])).toBe(true);
  });

  test("page: exact match on deep route → true", () => {
    expect(shouldAutoRefreshPath("/blog/my-post", [{ path: "/blog/my-post", type: "page" }])).toBe(
      true
    );
  });

  test("page: different path → false", () => {
    expect(shouldAutoRefreshPath("/about", [{ path: "/blog", type: "page" }])).toBe(false);
  });

  test("page: prefix is NOT a match (page is strict equality)", () => {
    // /blog should not match /blog/my-post for page invalidation
    expect(shouldAutoRefreshPath("/blog/my-post", [{ path: "/blog", type: "page" }])).toBe(false);
  });

  test("page: strips query string before comparing", () => {
    expect(shouldAutoRefreshPath("/blog?page=2", [{ path: "/blog", type: "page" }])).toBe(true);
  });

  test("page: empty invalidations → false", () => {
    expect(shouldAutoRefreshPath("/", [])).toBe(false);
  });

  test("page: one of multiple entries matches → true", () => {
    expect(
      shouldAutoRefreshPath("/about", [
        { path: "/home", type: "page" },
        { path: "/about", type: "page" },
      ])
    ).toBe(true);
  });

  // ── layout prefix match ─────────────────────────────────────────────────────

  test("layout: exact path match → true", () => {
    expect(shouldAutoRefreshPath("/board/abc", [{ path: "/board/abc", type: "layout" }])).toBe(
      true
    );
  });

  test("layout: direct child matches → true", () => {
    expect(
      shouldAutoRefreshPath("/board/abc/card/xyz", [{ path: "/board/abc", type: "layout" }])
    ).toBe(true);
  });

  test("layout: deeply nested child matches → true", () => {
    expect(
      shouldAutoRefreshPath("/board/abc/card/xyz/edit", [{ path: "/board/abc", type: "layout" }])
    ).toBe(true);
  });

  test("layout: sibling path does NOT match", () => {
    // /board/other is NOT under /board/abc
    expect(shouldAutoRefreshPath("/board/other", [{ path: "/board/abc", type: "layout" }])).toBe(
      false
    );
  });

  test("layout: partial segment prefix does NOT match", () => {
    // /board/abcdef should not be matched by /board/abc layout
    expect(shouldAutoRefreshPath("/board/abcdef", [{ path: "/board/abc", type: "layout" }])).toBe(
      false
    );
  });

  test("layout: root '/' invalidation matches every path", () => {
    expect(shouldAutoRefreshPath("/blog/post", [{ path: "/", type: "layout" }])).toBe(true);
    expect(shouldAutoRefreshPath("/", [{ path: "/", type: "layout" }])).toBe(true);
  });

  test("layout: trailing-slash path treated as prefix correctly", () => {
    expect(
      shouldAutoRefreshPath("/board/abc/card", [{ path: "/board/abc/", type: "layout" }])
    ).toBe(true);
  });

  test("layout: strips query string before prefix comparison", () => {
    expect(
      shouldAutoRefreshPath("/board/abc?view=kanban", [{ path: "/board/abc", type: "layout" }])
    ).toBe(true);
  });

  // ── mixed page + layout entries ─────────────────────────────────────────────

  test("mixed: layout match wins even when page does not match", () => {
    expect(
      shouldAutoRefreshPath("/board/abc/card/xyz", [
        { path: "/home", type: "page" },
        { path: "/board/abc", type: "layout" },
      ])
    ).toBe(true);
  });

  test("mixed: no entry matches → false", () => {
    expect(
      shouldAutoRefreshPath("/settings", [
        { path: "/home", type: "page" },
        { path: "/board/abc", type: "layout" },
      ])
    ).toBe(false);
  });
});
