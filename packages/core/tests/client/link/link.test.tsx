import { describe, expect, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FurinErrorBoundary } from "../../../src/client/boundaries.tsx";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import type {
  CacheEntry,
  LinkProps,
  LoadedClientRoute,
  PreloadStrategy,
  RouterContextValue,
  RouterProviderProps,
  RouteTo,
} from "../../../src/client/link.tsx";
import {
  applyRevalidateHeader,
  buildHref,
  buildRouterTree,
  classifySpaResponse,
  Link,
  RouterContext,
  shouldAutoRefreshPath,
  shouldRefetch,
} from "../../../src/client/link.tsx";
import { resolveRouteElement, selectRouteBoundary } from "../../../src/client/route-element.tsx";
import {
  encodeInvalidationEntry,
  serializeInvalidationPaths,
} from "../../../src/shared/invalidation-header.ts";
import type { NotFoundComponent } from "../../../src/shared/not-found.ts";
import { ROUTE_MATCHES_KEY } from "../../../src/shared/route-matches.ts";
import { findSearchDefaults } from "../../../src/shared/search-params.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const PRODUCTS_RE = /^\/products$/;
const PRODUCT_DETAIL_RE = /^\/products\/([^/]+)$/;
const PRODUCT_NEW_RE = /^\/products\/new$/;
const HREF_ATTRIBUTE_RE = /\shref="([^"]*)"/;

const assertNamedLinkJsx = () => {
  const valid = <Link params={{ boardId: 42 }} search={{ page: 1 }} to="/elysia-boards/:boardId" />;
  // @ts-expect-error a named dynamic link requires its path params
  const missingParams = <Link search={{ page: 1 }} to="/elysia-boards/:boardId" />;
  return [valid, missingParams];
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRouterContext(overrides: Partial<RouterContextValue> | undefined): RouterContextValue {
  return {
    basePath: "",
    currentHref: "/",
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    invalidatePrefetch: () => {
      /* noop */
    },
    isNavigating: false,
    navigate: () => Promise.resolve(),
    prefetch: () => {
      /* noop */
    },
    refresh: () => Promise.resolve(),
    search: {},
    searchRoutes: [],
    ...(overrides ?? {}),
  };
}

function renderWithRouter(element: React.ReactElement, ctx: RouterContextValue): string {
  return renderToStaticMarkup(createElement(RouterContext.Provider, { value: ctx }, element));
}

function getHref(html: string): string {
  const href = html.match(HREF_ATTRIBUTE_RE)?.[1];
  if (href === undefined) {
    throw new Error(`Rendered link is missing href: ${html}`);
  }
  return href;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRoute(opts: Partial<Omit<RuntimeRoute, "__type">> | undefined): RuntimeRoute {
  return { __type: "FURIN_ROUTE", ...(opts ?? {}) };
}

function makeMatch(
  component: React.FC<Record<string, unknown>>,
  pageRoute: RuntimeRoute,
  pattern: string | undefined
): LoadedClientRoute {
  const p = pattern ?? "/";
  return {
    component,
    load: () => Promise.resolve({ default: { _route: pageRoute, component } }),
    pageRoute,
    pattern: p,
    regex: new RegExp(`^${p}$`),
  };
}

function pageTree(match: LoadedClientRoute, data: { [key: string]: unknown }): React.ReactNode {
  return resolveRouteElement({
    boundaries: [],
    boundaryOptions: undefined,
    chain: collectRouteChainFromRoute(match.pageRoute),
    data,
    page: { component: match.component, pattern: match.pattern },
    reset: () => undefined,
    rootBoundary: undefined,
  });
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
    expect(buildHref("/blog", undefined, undefined)).toBe("/blog");
  });

  test("search with a single key — appends query string", () => {
    expect(buildHref("/blog", { page: 2 }, undefined)).toBe("/blog?page=2");
  });

  test("search with multiple keys — appends all non-null values", () => {
    const result = buildHref("/blog", { page: 1, tag: "react" }, undefined);
    expect(result).toContain("page=1");
    expect(result).toContain("tag=react");
    expect(result.startsWith("/blog?")).toBe(true);
  });

  test("null/undefined search values are omitted", () => {
    expect(buildHref("/blog", { page: 1, tag: null }, undefined)).toBe("/blog?page=1");
    expect(buildHref("/blog", { page: 1, tag: undefined }, undefined)).toBe("/blog?page=1");
  });

  test("empty search object — no query string appended", () => {
    expect(buildHref("/blog", {}, undefined)).toBe("/blog");
  });

  test("null search — no query string appended", () => {
    expect(buildHref("/blog", null, undefined)).toBe("/blog");
  });

  test("hash only — appends fragment", () => {
    expect(buildHref("/about", undefined, "section")).toBe("/about#section");
  });

  test("search and hash together", () => {
    expect(buildHref("/blog", { page: 2 }, "top")).toBe("/blog?page=2#top");
  });

  test("boolean search value — stringified", () => {
    expect(buildHref("/search", { active: true }, undefined)).toBe("/search?active=true");
  });

  test("array search value — appends one entry per item", () => {
    expect(buildHref("/search", { tag: ["react", "furin"] }, undefined)).toBe(
      "/search?tag=react&tag=furin"
    );
    expect(buildHref("/search", { tag: ["react", undefined, null, "furin"] }, undefined)).toBe(
      "/search?tag=react&tag=furin"
    );
  });

  test("object search value — serializes as JSON", () => {
    expect(buildHref("/search", { filter: { tag: "react" } }, undefined)).toBe(
      "/search?filter=%7B%22tag%22%3A%22react%22%7D"
    );
  });

  test("default-equivalent search values are omitted when defaults are known", () => {
    expect(buildHref("/products", { page: 1, q: "" }, undefined, { page: 1, q: "" })).toBe(
      "/products"
    );
  });

  test("non-default search values remain visible when defaults are known", () => {
    expect(buildHref("/products", { page: 2, q: "" }, undefined, { page: 1, q: "" })).toBe(
      "/products?page=2"
    );
  });
});

describe("findSearchDefaults", () => {
  test("uses the most specific matching route", () => {
    expect(
      findSearchDefaults("/products/new", [
        { pattern: "/products/:id", regex: PRODUCT_DETAIL_RE, searchDefaults: { tab: "id" } },
        {
          pattern: "/products/new",
          regex: PRODUCT_NEW_RE,
          searchDefaults: { tab: "new" },
        },
      ])
    ).toEqual({ tab: "new" });
  });
});

// ── resolveRouteElement ───────────────────────────────────────────────────────

describe("resolveRouteElement", () => {
  const data = { title: "test" };

  const Page: React.FC<Record<string, unknown>> = () => createElement("p", null, "page");

  test("no layout — returns the page element directly", () => {
    const match = makeMatch(Page, makeRoute(undefined), undefined);
    expect(renderToStaticMarkup(pageTree(match, data))).toBe("<p>page</p>");
  });

  test("one layout in pageRoute (no root) — wraps the page", () => {
    const Layout: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("main", null, children);

    const match = makeMatch(Page, makeRoute({ layout: Layout }), undefined);
    expect(renderToStaticMarkup(pageTree(match, data))).toBe("<main><p>page</p></main>");
  });

  test("root layout only (no nested layout) — root wraps the page", () => {
    const Root: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("body", null, children);

    const root = makeRoute({ layout: Root });
    const match = makeMatch(Page, makeRoute({ parent: root }), undefined); // pageRoute has no layout
    expect(renderToStaticMarkup(pageTree(match, data))).toBe("<body><p>page</p></body>");
  });

  test("root + nested layout — root wraps nested which wraps page", () => {
    const Root: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("section", { "data-root": true }, children);
    const Nav: React.FC<{ children: React.ReactNode }> = ({ children }) =>
      createElement("nav", null, children);

    const rootRoute = makeRoute({ layout: Root });
    const pageRoute = makeRoute({ layout: Nav, parent: rootRoute });
    const match = makeMatch(Page, pageRoute, "/dashboard");

    expect(renderToStaticMarkup(pageTree(match, data))).toBe(
      '<section data-root="true"><nav><p>page</p></nav></section>'
    );
  });

  test("passes loader data to the page component as props", () => {
    const DataPage: React.FC<Record<string, unknown>> = ({ title }) =>
      createElement("h1", null, String(title));

    const match = makeMatch(DataPage, makeRoute(undefined), undefined);
    expect(renderToStaticMarkup(pageTree(match, { title: "Hello World" }))).toBe(
      "<h1>Hello World</h1>"
    );
  });

  test("exposes request fields as stable promises to pages and layouts", async () => {
    let pageUser: unknown;
    let layoutUser: unknown;
    let pageHasRequestData = false;
    const PrivatePage: React.FC<Record<string, unknown>> = (props) => {
      pageUser = props.user;
      pageHasRequestData = "requestData" in props;
      return createElement("p", null, "page");
    };
    const PrivateLayout: React.FC<Record<string, unknown> & { children: React.ReactNode }> = (
      props
    ) => {
      layoutUser = props.user;
      return createElement("main", null, props.children);
    };
    const route = makeRoute({ layout: PrivateLayout });
    const match = makeMatch(PrivatePage, route, undefined);
    const user = Promise.resolve("Alice");

    expect(renderToStaticMarkup(pageTree(match, { user }))).toBe("<main><p>page</p></main>");
    expect(pageUser).toBe(layoutUser);
    expect(pageHasRequestData).toBe(false);
    expect(await pageUser).toBe("Alice");
  });

  test("keeps an absent optional public prop absent when request data is pending", () => {
    let optional: unknown;
    const PageWithOptional: React.FC<Record<string, unknown>> = ({ optional: value }) => {
      optional = value;
      return createElement("p", null, "page");
    };
    const match = makeMatch(PageWithOptional, makeRoute(undefined), undefined);
    renderToStaticMarkup(pageTree(match, { user: Promise.resolve("Alice") }));
    expect(optional).toBeUndefined();
  });

  test("passes loader data to layout components as props", () => {
    const Layout: React.FC<Record<string, unknown>> = ({ title, children }) =>
      createElement("div", { "data-title": String(title) }, children as React.ReactNode);

    const match = makeMatch(Page, makeRoute({ layout: Layout }), undefined);
    expect(renderToStaticMarkup(pageTree(match, { title: "My Blog" }))).toBe(
      '<div data-title="My Blog"><p>page</p></div>'
    );
  });
});

// ── Link ──────────────────────────────────────────────────────────────────────

describe("Link", () => {
  test("renders an <a> tag with the given to path", () => {
    const html = renderToStaticMarkup(createElement(Link, { to: "/blog" }, "Blog"));
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain('href="/blog"');
    expect(html).toContain(">Blog</a>");
  });

  test("passes through className", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { className: "nav-link", to: "/about" }, "About")
    );
    expect(html).toContain('class="nav-link"');
    expect(html).toContain('href="/about"');
  });

  test("passes through aria attributes", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { "aria-label": "Home page", to: "/" }, "Home")
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
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain(">External</a>");
  });

  test("renders without children", () => {
    const html = renderToStaticMarkup(createElement(Link, { to: "/empty" as string }));
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain('href="/empty"');
    expect(html).toContain("></a>");
  });

  test("search params are serialized into the href", () => {
    const html = renderToStaticMarkup(
      // Cast to string since RouteManifest is unaugmented in tests
      createElement(Link, { search: { page: 2 }, to: "/blog" as string }, "Next")
    );
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain('href="/blog?page=2"');
    expect(html).toContain(">Next</a>");
  });

  test("search params equal to route defaults are omitted from the href", () => {
    const ctx = makeRouterContext({
      searchRoutes: [{ pattern: "/products", regex: PRODUCTS_RE, searchDefaults: { page: 1 } }],
    } as Partial<RouterContextValue>);

    const html = renderWithRouter(
      createElement(Link, { search: { page: 1 }, to: "/products" as string }, "Products"),
      ctx
    );

    expect(html).toContain('data-furin-link="true"');
    expect(getHref(html)).toBe("/products");
    expect(html).toContain(">Products</a>");
  });

  test("external href search params are not stripped by internal route defaults", () => {
    const ctx = makeRouterContext({
      searchRoutes: [{ pattern: "/products", regex: PRODUCTS_RE, searchDefaults: { page: 1 } }],
    } as Partial<RouterContextValue>);

    const html = renderWithRouter(
      createElement(
        Link,
        { search: { page: 1 }, to: "https://example.com/products" as string },
        "Products"
      ),
      ctx
    );

    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain('href="https://example.com/products?page=1"');
    expect(html).toContain(">Products</a>");
  });

  test("hash is appended to the href", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { hash: "team", to: "/about" as string }, "Team")
    );
    expect(html).toContain('data-furin-link="true"');
    expect(html).toContain('href="/about#team"');
    expect(html).toContain(">Team</a>");
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
        // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
        children: ({ isActive }: { isActive: boolean }) =>
          createElement("span", { "data-active": String(isActive) }, "Blog"),
        to: "/blog" as string,
      })
    );
    expect(html).toContain('data-active="false"');
    expect(html).toContain("<span");
  });

  test("children as render function — receives isActive=true when to='/'", () => {
    const html = renderToStaticMarkup(
      createElement(Link, {
        // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
        children: ({ isActive }: { isActive: boolean }) =>
          createElement("span", { "data-active": String(isActive) }, "Home"),
        to: "/" as string,
      })
    );
    expect(html).toContain('data-active="true"');
  });

  test("activeProps — merges className when link is active (to='/')", () => {
    const html = renderToStaticMarkup(
      createElement(
        Link,
        {
          activeProps: ({ isActive }) => (isActive ? { className: "active-link" } : {}),
          to: "/" as string,
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
          inactiveProps: () => ({ className: "muted-link" }),
          to: "/blog" as string,
        },
        "Blog"
      )
    );
    expect(html).toContain('class="muted-link"');
    expect(html).not.toContain("data-status");
  });

  test("disabled — renders aria-disabled and keeps href", () => {
    const html = renderToStaticMarkup(
      createElement(Link, { disabled: true, to: "/about" as string }, "About")
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
  test("JSX Link requires params for a named dynamic route", () => {
    expectTypeOf(assertNamedLinkJsx).toBeFunction();
  });

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

  test("RouterContextValue.refresh returns Promise<void> and accepts explicit resetScroll options", () => {
    expectTypeOf<RouterContextValue["refresh"]>().toBeCallableWith(undefined);
    expectTypeOf<RouterContextValue["refresh"]>().toBeCallableWith({ resetScroll: true });
    expectTypeOf<RouterContextValue["refresh"]>().toBeCallableWith({ resetScroll: false });
    expectTypeOf<ReturnType<RouterContextValue["refresh"]>>().toEqualTypeOf<Promise<void>>();
  });

  test("RouterProviderProps.autoRefresh is a required boolean", () => {
    expectTypeOf<RouterProviderProps["autoRefresh"]>().toEqualTypeOf<boolean>();
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

  test("RouterProviderProps.prefetchCacheSize is a required number", () => {
    expectTypeOf<RouterProviderProps["prefetchCacheSize"]>().toEqualTypeOf<number>();
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
  test("keeps literal layout suffixes distinct from the layout marker", () => {
    const entries = [
      encodeInvalidationEntry("/foo:layout", "page"),
      encodeInvalidationEntry("/foo:layout", "layout"),
    ];
    const calls: [string, string | undefined][] = [];
    applyRevalidateHeader(
      new Headers({ "x-furin-revalidate": serializeInvalidationPaths(entries) }),
      (path, type) => calls.push([path, type])
    );
    expect(calls).toEqual([
      ["/foo:layout", "page"],
      ["/foo:layout", "layout"],
    ]);
  });
  test("decodes Unicode, commas and percent signs without splitting a path", () => {
    const paths: [string, "page" | "layout" | undefined][] = [];
    applyRevalidateHeader(
      new Headers({
        "x-furin-revalidate": "/%E6%9D%B1%E4%BA%AC,/items/a%2Cb:layout,/literal%2520",
      }),
      (path, type) => paths.push([path, type])
    );
    expect(paths).toEqual([
      ["/東京", "page"],
      ["/items/a,b", "layout"],
      ["/literal%20", "page"],
    ]);
  });

  test("preserves malformed percent escapes from older header producers", () => {
    const paths: string[] = [];
    applyRevalidateHeader(new Headers({ "x-furin-revalidate": "/legacy%invalid" }), (path) =>
      paths.push(path)
    );
    expect(paths).toEqual(["/legacy%invalid"]);
  });
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
  test("matches encoded browser paths against Unicode and reserved-character invalidations", () => {
    const invalidations: { path: string; type: "page" | "layout" }[] = [];
    applyRevalidateHeader(
      new Headers({ "x-furin-revalidate": "/%E6%9D%B1%E4%BA%AC,/a%2Cb" }),
      (path, type) => invalidations.push({ path, type: type ?? "page" })
    );
    expect(shouldAutoRefreshPath("/%E6%9D%B1%E4%BA%AC", invalidations)).toBe(true);
    expect(shouldAutoRefreshPath("/a%2Cb", invalidations)).toBe(true);
    expect(shouldAutoRefreshPath("/a,b", invalidations)).toBe(true);
    expect(shouldAutoRefreshPath("/a/b", [{ path: "/a%2Fb", type: "page" }])).toBe(false);
  });
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

// ── classifySpaResponse (Slice 8) ─────────────────────────────────────────────
//
// Pure classifier used by `fetchPageState` to decide whether a fetch response
// represents a normal page (→ render), a server-signalled 404 (→ render
// not-found inline), or an unrecoverable state (→ bail to full-page reload).
// The signal is a failed match in `__FURIN_DATA__.__furinMatches`.

function failedMatches(failure: { [key: string]: unknown }): { [key: string]: unknown } {
  return { [ROUTE_MATCHES_KEY]: [{ fields: {}, status: "success" }, failure] };
}

describe("classifySpaResponse", () => {
  test("2xx response with valid data → ok", () => {
    expect(classifySpaResponse(200, { foo: "bar" })).toEqual({ kind: "ok" });
  });

  test("404 with a notFound match → not-found carrying message + data", () => {
    const result = classifySpaResponse(
      404,
      failedMatches({
        error: { data: { id: "abc" }, message: "Post not found" },
        status: "notFound",
      })
    );
    expect(result).toEqual({
      error: { data: { id: "abc" }, message: "Post not found" },
      kind: "not-found",
    });
  });

  test("404 WITHOUT a failed match → bail (unknown 404 payload without SPA signal)", () => {
    // renderRootNotFound always embeds a notFound match in __FURIN_DATA__,
    // but a 404 without the signal still bails (e.g. proxy-rewritten responses).
    expect(classifySpaResponse(404, {})).toEqual({ kind: "bail" });
  });

  test("500 response without an error match → bail (full reload)", () => {
    // No sentinel means an opaque server error (e.g. crash before the data
    // endpoint formed a response) — fall back to a full-page navigation so
    // the browser shows whatever the server sent.
    expect(classifySpaResponse(500, {})).toEqual({ kind: "bail" });
  });

  test("null/missing data → bail (cannot render without loader data)", () => {
    expect(classifySpaResponse(200, null)).toEqual({ kind: "bail" });
  });

  test("200 with a notFound match trusts the payload signal over HTTP status", () => {
    // Guards against odd proxy/CDN setups that rewrite the status but preserve HTML.
    const result = classifySpaResponse(200, failedMatches({ error: {}, status: "notFound" }));
    expect(result).toEqual({ error: {}, kind: "not-found" });
  });

  test("500 with an error match → error kind carrying the payload", () => {
    const result = classifySpaResponse(
      500,
      failedMatches({
        error: { digest: "abc1234567", message: "Boom", status: 500 },
        status: "error",
      })
    );
    expect(result).toEqual({
      error: { digest: "abc1234567", message: "Boom", status: 500 },
      kind: "error",
    });
  });

  test("403 with an error match → error kind carrying the original status", () => {
    const result = classifySpaResponse(
      403,
      failedMatches({
        error: { digest: "deadbeef00", message: "Forbidden", status: 403 },
        status: "error",
      })
    );
    expect(result).toEqual({
      error: { digest: "deadbeef00", message: "Forbidden", status: 403 },
      kind: "error",
    });
  });

  test("200 with an error match still classifies as error (proxy-rewrite guard)", () => {
    // Trust the payload over the HTTP status to handle proxies that rewrite codes.
    const result = classifySpaResponse(
      200,
      failedMatches({
        error: { digest: "feed00face", message: "Server error", status: 500 },
        status: "error",
      })
    );
    expect(result).toEqual({
      error: { digest: "feed00face", message: "Server error", status: 500 },
      kind: "error",
    });
  });
});

// ── selectRouteBoundary ───────────────────────────────────────────────────────
//
// A failure at segment `index` (route-chain index; the page comes after the
// chain) is handled by the deepest boundary declared ABOVE that segment: a
// boundary sits inside the layout of its own depth, so it cannot catch that
// layout's failure (Next.js `error.tsx` scope).

describe("selectRouteBoundary", () => {
  const NF1: NotFoundComponent = () => createElement("p", null, "nf1");
  const NF2: NotFoundComponent = () => createElement("p", null, "nf2");
  const E2 = (() => null) as never;

  test("a page failure picks the deepest boundary declaring the kind", () => {
    const boundaries = [
      { depth: 0, notFound: NF1 },
      { depth: 2, notFound: NF2 },
    ];
    expect(selectRouteBoundary(boundaries, undefined, 4, "notFound")).toEqual({
      component: NF2,
      depth: 2,
    });
  });

  test("a deeper boundary without the kind falls back to a shallower one", () => {
    const boundaries = [
      { depth: 0, notFound: NF1 },
      { depth: 2, error: E2 },
    ];
    expect(selectRouteBoundary(boundaries, undefined, 4, "notFound")).toEqual({
      component: NF1,
      depth: 0,
    });
  });

  test("a layout failure skips the boundary declared in its own directory", () => {
    const boundaries = [
      { depth: 0, notFound: NF1 },
      { depth: 2, notFound: NF2 },
    ];
    expect(selectRouteBoundary(boundaries, undefined, 2, "notFound")).toEqual({
      component: NF1,
      depth: 0,
    });
  });

  test("without an authored boundary the built-in screen renders inside the root layout", () => {
    expect(selectRouteBoundary([], undefined, 3, "error")).toEqual({
      component: undefined,
      depth: 0,
    });
  });

  test("a root failure uses the root boundary inside the minimal document", () => {
    const boundaries = [{ depth: 0, notFound: NF2 }];
    expect(selectRouteBoundary(boundaries, { notFound: NF1 }, 0, "notFound")).toEqual({
      component: NF1,
      depth: -1,
    });
  });
});

// ── buildRouterTree (Slice 9 + 10) ────────────────────────────────────────────
//
// Root-level safety net. Wraps the entire RouterProvider render tree in a
// FurinErrorBoundary so that ANY render error (root layout, hydration
// mismatch, scaffolding code) that escapes per-segment boundaries still
// surfaces a graceful fallback instead of crashing to a blank page.
//
// The `initialDigest` prop (Slice 10) carries the server-logged error id
// from the failed route match in __FURIN_DATA__ — letting client fallback UIs
// show the same id a user would find in server logs.

describe("buildRouterTree", () => {
  const page = createElement("p", null, "page");

  test("returns a RouterContext.Provider as the outermost element", () => {
    const tree = buildRouterTree(makeRouterContext(undefined), page, {});
    expect(tree.type).toBe(RouterContext.Provider);
  });

  test("passes the page element through inside FurinErrorBoundary", () => {
    const ctx = makeRouterContext({ currentHref: "/abc" });
    const tree = buildRouterTree(ctx, page, {});
    // RouterContext.Provider.children = FurinErrorBoundary
    const boundaryEl = (tree.props as { children: React.ReactElement }).children;
    expect(boundaryEl.type).toBe(FurinErrorBoundary);
    // FurinErrorBoundary.children = the page element
    expect((boundaryEl.props as { children: React.ReactNode }).children).toBe(page);
    // Router context value is on the outermost Provider
    expect((tree.props as { value: RouterContextValue }).value.currentHref).toBe("/abc");
  });

  test("forwards digest onto the root boundary (Slice 10 — rehydration)", () => {
    const tree = buildRouterTree(makeRouterContext(undefined), page, { digest: "deadbeef12" });
    const boundaryEl = (tree.props as { children: React.ReactElement }).children;
    expect((boundaryEl.props as { digest?: string }).digest).toBe("deadbeef12");
  });

  test("forwards onReset + resetKey onto the root boundary", () => {
    const onReset = () => {
      /* noop */
    };
    const tree = buildRouterTree(makeRouterContext(undefined), page, {
      onReset,
      resetKey: "/blog",
    });
    const boundaryEl = (tree.props as { children: React.ReactElement }).children;
    const props = boundaryEl.props as { onReset?: () => void; resetKey?: string };
    expect(props.onReset).toBe(onReset);
    expect(props.resetKey).toBe("/blog");
  });

  test("omits digest when not provided (no false correlation)", () => {
    const tree = buildRouterTree(makeRouterContext(undefined), page, {});
    const boundaryEl = (tree.props as { children: React.ReactElement }).children;
    expect((boundaryEl.props as { digest?: string }).digest).toBeUndefined();
  });

  test("renders children unchanged when no error is thrown (SSR passthrough)", () => {
    const html = renderToStaticMarkup(
      buildRouterTree(makeRouterContext(undefined), createElement("h1", null, "hello"), {})
    );
    expect(html).toContain("hello");
  });

  test("omits no fallback prop (uses FurinErrorBoundary's built-in default)", () => {
    // The TOP boundary is the LAST line of defense — users who want a custom
    // global error UI declare a root-level error.tsx, which segmentBoundaries
    // already picks up at depth 0. The top boundary stays with the built-in
    // default so there's always something to render even if user's own
    // error.tsx throws during its own render.
    const tree = buildRouterTree(makeRouterContext(undefined), page, {});
    const boundaryEl = (tree.props as { children: React.ReactElement }).children;
    expect((boundaryEl.props as { fallback?: unknown }).fallback).toBeUndefined();
  });
});
