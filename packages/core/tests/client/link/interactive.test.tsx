import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Link,
  RouterContext,
  type RouterContextValue,
  SSR_FALLBACK_ROUTER,
} from "../../../src/client/link.tsx";
import { setPrefetchCacheEntry } from "../../../src/client/router/provider.tsx";
import type { CacheEntry } from "../../../src/client/router/types.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

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

interface RenderResult {
  anchor: HTMLAnchorElement;
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

function renderLink(
  element: React.ReactElement,
  ctx: RouterContextValue | undefined
): RenderResult {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  const wrapped = ctx ? createElement(RouterContext.Provider, { value: ctx }, element) : element;

  act(() => {
    root.render(wrapped);
  });

  const anchor = container.querySelector("a") as HTMLAnchorElement;

  return {
    anchor,
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
    container,
    root,
  };
}

function dispatchReactEvent(target: EventTarget, event: Event): void {
  act(() => {
    target.dispatchEvent(event);
  });
}

function preventHappyDomAnchorNavigation(event: MouseEvent): void {
  const { target } = event;
  if (!(target instanceof Element && target.closest("a"))) {
    return;
  }
  event.preventDefault();
}

// ── Mock IntersectionObserver ─────────────────────────────────────────────────

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  callback: IntersectionObserverCallback;
  elements: Element[] = [];

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  observe(element: Element): void {
    this.elements.push(element);
  }

  disconnect(): void {
    this.elements = [];
  }

  trigger(isIntersecting: boolean): void {
    const entries = this.elements.map((target) => ({
      boundingClientRect: {} as DOMRectReadOnly,
      intersectionRatio: isIntersecting ? 1 : 0,
      intersectionRect: {} as DOMRectReadOnly,
      isIntersecting,
      rootBounds: null,
      target,
      time: Date.now(),
    }));
    this.callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
  }

  static cleanup(): void {
    MockIntersectionObserver.instances = [];
  }
}

const OriginalIntersectionObserver = globalThis.IntersectionObserver;

// ── SSR path ──────────────────────────────────────────────────────────────────

describe("Link SSR path", () => {
  test("renders via RouterContext.Consumer when window is undefined", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(createElement(Link, { to: "/blog" }, "Blog"));
      expect(html).toBe('<a data-furin-link="true" href="/blog">Blog</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR_FALLBACK_ROUTER methods are safe no-ops", async () => {
    expect(await SSR_FALLBACK_ROUTER.navigate("/", undefined)).toBe(undefined);
    expect(SSR_FALLBACK_ROUTER.prefetch("/", undefined)).toBe(undefined);
    expect(SSR_FALLBACK_ROUTER.invalidatePrefetch("/", "page")).toBe(undefined);
    expect(await SSR_FALLBACK_ROUTER.refresh(undefined)).toBe(undefined);
  });

  test("SSR: uses basePath from RouterContext.Provider", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "/furin",
              currentHref: "/docs",
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
            },
          },
          createElement(Link, { to: "/docs" }, "Docs")
        )
      );
      expect(html).toBe(
        '<a data-furin-link="true" href="/furin/docs" data-status="active">Docs</a>'
      );
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: search and hash are appended", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(Link, { hash: "comments", search: { page: 2 }, to: "/blog" }, "Blog")
      );
      expect(html).toBe('<a data-furin-link="true" href="/blog?page=2#comments">Blog</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: aria-disabled when disabled", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(Link, { disabled: true, to: "/about" }, "About")
      );
      expect(html).toBe('<a data-furin-link="true" href="/about" aria-disabled="true">About</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: children as render function", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(Link, {
          // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
          children: ({ isActive }: { isActive: boolean }) =>
            createElement("span", { "data-active": String(isActive) }, "Home"),
          to: "/",
        })
      );
      expect(html).toContain('data-active="true"');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: activeProps merged when active", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
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
            },
          },
          createElement(
            Link,
            {
              activeProps: ({ isActive }) => (isActive ? { className: "active-link" } : {}),
              to: "/",
            },
            "Home"
          )
        )
      );
      expect(html).toContain('class="active-link"');
      expect(html).toContain('data-status="active"');
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: inactiveProps merged when inactive", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "",
              currentHref: "/other",
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
            },
          },
          createElement(
            Link,
            {
              inactiveProps: () => ({ className: "muted-link" }),
              to: "/blog",
            },
            "Blog"
          )
        )
      );
      expect(html).toContain('class="muted-link"');
      expect(html).not.toContain("data-status");
    } finally {
      globalThis.window = originalWindow;
    }
  });

  test("SSR: ignores spurious href prop so basePath is preserved", () => {
    const originalWindow = globalThis.window;
    // @ts-expect-error: intentionally removing window for SSR branch coverage
    globalThis.window = undefined;

    try {
      const html = renderToStaticMarkup(
        createElement(
          RouterContext.Provider,
          {
            value: {
              basePath: "/furin",
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
            },
          },
          createElement(
            Link,
            {
              href: "/blog",
              to: "/blog",
            } as any,
            "Blog"
          )
        )
      );
      expect(html).toBe('<a data-furin-link="true" href="/furin/blog">Blog</a>');
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe("prefetch cache helpers", () => {
  test("setPrefetchCacheEntry evicts the oldest entry when the cap is exceeded", () => {
    const cache = new Map<string, CacheEntry>();
    const entry = (id: string): CacheEntry => ({
      createdAt: Date.now(),
      promise: Promise.resolve({
        data: { id },
        match: null,
        notFound: { message: id },
      }),
      staleTime: 30_000,
    });

    setPrefetchCacheEntry(cache, "/a", entry("a"), 2);
    setPrefetchCacheEntry(cache, "/b", entry("b"), 2);
    setPrefetchCacheEntry(cache, "/c", entry("c"), 2);

    expect([...cache.keys()]).toEqual(["/b", "/c"]);
  });
});

// ── LinkInteractive (client) ──────────────────────────────────────────────────

describe("LinkInteractive — client-side behaviour", () => {
  test("download links retain native navigation", () => {
    const navigate = mock(() => Promise.resolve());
    const view = renderLink(
      createElement(Link, { to: "/asset", download: "asset.txt" }, "Download"),
      makeRouterContext({ navigate })
    );
    dispatchReactEvent(view.anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).not.toHaveBeenCalled();
    view.cleanup();
  });

  test("same-origin absolute links navigate using the logical mount path", () => {
    const navigate = mock(() => Promise.resolve());
    const view = renderLink(
      createElement(Link, { to: `${window.location.origin}/furin/about?q=1#part` }, "About"),
      makeRouterContext({ basePath: "/furin", navigate })
    );
    dispatchReactEvent(view.anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).toHaveBeenCalledWith("/about?q=1#part", {
      replace: undefined,
      resetScroll: true,
    });
    view.cleanup();
  });
  let originalOpen: typeof window.open | undefined;
  let originalHrefDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    installDom();
    resetDomState();
    MockIntersectionObserver.cleanup();
    globalThis.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;

    // happy-dom navigates on <a> clicks when preventDefault() is not called.
    // That async navigation loads stylesheets/scripts that throw uncaught
    // errors (missing SyntaxError, disabled module loading, etc.) and bleed
    // into the next test. We stub window.open so browser-level navigation
    // is suppressed while React handlers still run for SPA routing asserts.
    originalOpen =
      typeof window !== "undefined" && typeof window.open !== "undefined" ? window.open : undefined;
    if (typeof window !== "undefined") {
      (window as Window & { open?: typeof window.open }).open = () => null;
    }

    // Also freeze window.location.href so happy-dom can't navigate away
    // on anchor clicks — React's synthetic-event preventDefault() doesn't
    // reliably stop native navigation in happy-dom.
    originalHrefDescriptor =
      typeof window !== "undefined" && typeof window.location !== "undefined"
        ? Object.getOwnPropertyDescriptor(window.location, "href")
        : undefined;
    Object.defineProperty(window.location, "href", {
      configurable: true,
      get: () => "http://localhost:3000/",
      set: () => {
        /* no-op */
      },
    });
    document.addEventListener("click", preventHappyDomAnchorNavigation);
  });

  afterEach(async () => {
    document.removeEventListener("click", preventHappyDomAnchorNavigation);
    if (OriginalIntersectionObserver) {
      globalThis.IntersectionObserver = OriginalIntersectionObserver;
    } else {
      // biome-ignore lint/performance/noDelete: remove test-only DOM shim before unregistering happy-dom
      delete (globalThis as unknown as { IntersectionObserver?: unknown }).IntersectionObserver;
    }
    MockIntersectionObserver.cleanup();
    if (originalOpen && typeof window !== "undefined") {
      window.open = originalOpen;
    }
    if (typeof window !== "undefined" && typeof window.location !== "undefined") {
      if (originalHrefDescriptor) {
        Object.defineProperty(window.location, "href", originalHrefDescriptor);
      } else {
        // href lives on the Location prototype — delete our own-property override
        // biome-ignore lint/performance/noDelete: removing an own property to restore prototype accessor behavior
        delete (window.location as unknown as { href?: unknown }).href;
      }
    }
    await uninstallDom();
  });

  // ── Rendering ───────────────────────────────────────────────────────────────

  test("renders an anchor with correct href", () => {
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), undefined);
    expect(anchor.tagName).toBe("A");
    expect(anchor.getAttribute("href")).toBe("/blog");
    expect(anchor.textContent).toBe("Blog");
    cleanup();
  });

  test("includes basePath in the physical href", () => {
    const ctx = makeRouterContext({ basePath: "/furin" });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/docs" }, "Docs"), ctx);
    expect(anchor.getAttribute("href")).toBe("/furin/docs");
    cleanup();
  });

  test("appends search and hash to href", () => {
    const ctx = makeRouterContext(undefined);
    const { anchor, cleanup } = renderLink(
      createElement(Link, { hash: "comments", search: { page: 2 }, to: "/blog" }, "Blog"),
      ctx
    );
    expect(anchor.getAttribute("href")).toBe("/blog?page=2#comments");
    cleanup();
  });

  test("data-status='active' when currentHref matches logical path", () => {
    const ctx = makeRouterContext({ currentHref: "/blog" });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);
    expect(anchor.getAttribute("data-status")).toBe("active");
    cleanup();
  });

  test("no data-status when link is inactive", () => {
    const ctx = makeRouterContext({ currentHref: "/other" });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);
    expect(anchor.hasAttribute("data-status")).toBe(false);
    cleanup();
  });

  test("aria-disabled when disabled", () => {
    const { anchor, cleanup } = renderLink(
      createElement(Link, { disabled: true, to: "/about" }, "About"),
      undefined
    );
    expect(anchor.getAttribute("aria-disabled")).toBe("true");
    cleanup();
  });

  test("children as render function receives isActive", () => {
    const ctx = makeRouterContext({ currentHref: "/active" });
    const { container, cleanup } = renderLink(
      createElement(Link, {
        // biome-ignore lint/correctness/noChildrenProp: function-children must be passed via props
        children: ({ isActive }: { isActive: boolean }) =>
          createElement("span", { "data-active": String(isActive) }),
        to: "/active",
      }),
      ctx
    );
    const span = container.querySelector("span");
    expect(span?.getAttribute("data-active")).toBe("true");
    cleanup();
  });

  test("activeProps merged when active", () => {
    const ctx = makeRouterContext({ currentHref: "/" });
    const { anchor, cleanup } = renderLink(
      createElement(
        Link,
        {
          activeProps: ({ isActive }) => (isActive ? { className: "active-link" } : {}),
          to: "/",
        },
        "Home"
      ),
      ctx
    );
    expect(anchor.className).toBe("active-link");
    cleanup();
  });

  test("inactiveProps merged when inactive", () => {
    const ctx = makeRouterContext({ currentHref: "/other" });
    const { anchor, cleanup } = renderLink(
      createElement(
        Link,
        {
          inactiveProps: () => ({ className: "muted-link" }),
          to: "/blog",
        },
        "Blog"
      ),
      ctx
    );
    expect(anchor.className).toBe("muted-link");
    cleanup();
  });

  // ── Click handling ──────────────────────────────────────────────────────────

  test("click navigates for internal link", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("/blog", { replace: undefined, resetScroll: true });
    cleanup();
  });

  test("click does not navigate when disabled", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { disabled: true, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with ctrl key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(
      anchor,
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with meta key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(
      anchor,
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with shift key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(
      anchor,
      new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate with alt key", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(
      anchor,
      new MouseEvent("click", { altKey: true, bubbles: true, cancelable: true })
    );

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate when target is _blank", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { target: "_blank", to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate for external link", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "https://example.com" }, "External"),
      ctx
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate when href is unparseable", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "http://" }, "Broken"), ctx);

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("click calls custom onClick", () => {
    const onClick = mock<(e: React.MouseEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { onClick, to: "/blog" }, "Blog"),
      undefined
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(onClick).toHaveBeenCalled();
    cleanup();
  });

  test("click does not navigate if onClick calls preventDefault", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const onClick = (e: React.MouseEvent) => e.preventDefault();
    const { anchor, cleanup } = renderLink(
      createElement(Link, { onClick, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).not.toHaveBeenCalled();
    cleanup();
  });

  test("navigate passes replace option", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { replace: true, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("/blog", { replace: true, resetScroll: true });
    cleanup();
  });

  test("navigate passes resetScroll=false", () => {
    const navigate = mock<RouterContextValue["navigate"]>(() => Promise.resolve());
    const ctx = makeRouterContext({ navigate });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { resetScroll: false, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(navigate).toHaveBeenCalledWith("/blog", { replace: undefined, resetScroll: false });
    cleanup();
  });

  // ── Prefetch: render ────────────────────────────────────────────────────────

  test('preload="render" triggers prefetch on mount', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { preload: "render", to: "/blog" }, "Blog"),
      ctx
    );

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 30_000 });
    cleanup();
  });

  test('preload="render" uses custom preloadStaleTime', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { preload: "render", preloadStaleTime: 5000, to: "/blog" }, "Blog"),
      ctx
    );

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 5000 });
    cleanup();
  });

  // ── Prefetch: viewport ──────────────────────────────────────────────────────

  test('preload="viewport" observes anchor with IntersectionObserver', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { preload: "viewport", to: "/blog" }, "Blog"),
      ctx
    );

    expect(MockIntersectionObserver.instances.length).toBe(1);
    const instance = MockIntersectionObserver.instances[0] as MockIntersectionObserver;
    expect(instance.elements.length).toBe(1);
    cleanup();
  });

  test('preload="viewport" triggers prefetch when intersecting', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { preload: "viewport", to: "/blog" }, "Blog"),
      ctx
    );

    const instance = MockIntersectionObserver.instances[0] as MockIntersectionObserver;
    instance.trigger(true);

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 30_000 });
    cleanup();
  });

  test('preload="viewport" does not prefetch when not intersecting', () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { preload: "viewport", to: "/blog" }, "Blog"),
      ctx
    );

    const instance = MockIntersectionObserver.instances[0] as MockIntersectionObserver;
    instance.trigger(false);

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("preload=false does not set up viewport observer", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { cleanup } = renderLink(
      createElement(Link, { preload: false, to: "/blog" }, "Blog"),
      ctx
    );

    expect(MockIntersectionObserver.instances.length).toBe(0);
    cleanup();
  });

  // ── Prefetch: intent (mouse enter / focus) ──────────────────────────────────

  test("mouse enter triggers intent prefetch after delay", async () => {
    const calls: Array<{ args: unknown[] }> = [];
    const prefetch = ((...args: unknown[]) => {
      calls.push({ args });
    }) as RouterContextValue["prefetch"];
    const ctx = makeRouterContext({ defaultPreloadDelay: 10, prefetch });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    expect(calls.length).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls.length).toBe(1);
    const [firstCall] = calls;
    if (!firstCall) {
      throw new Error("Expected at least one prefetch call");
    }
    expect(firstCall.args).toEqual(["/blog", { staleTime: 30_000 }]);
    cleanup();
  });

  test("mouse enter does not prefetch when disabled", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ defaultPreloadDelay: 10, prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { disabled: true, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse enter does not prefetch for external link", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ defaultPreloadDelay: 10, prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "https://example.com" }, "External"),
      ctx
    );

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse enter does not prefetch when preload is not intent", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ defaultPreloadDelay: 10, prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { preload: false, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse leave cancels pending intent prefetch", async () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ defaultPreloadDelay: 50, prefetch });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );
    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
    );

    await new Promise((r) => setTimeout(r, 70));
    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("focus triggers intent prefetch immediately", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), ctx);

    dispatchReactEvent(anchor, new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).toHaveBeenCalledWith("/blog", { staleTime: 30_000 });
    cleanup();
  });

  test("focus does not prefetch when disabled", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { disabled: true, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("focus does not prefetch for external link", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { to: "https://example.com" }, "External"),
      ctx
    );

    dispatchReactEvent(anchor, new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("focus does not prefetch when preload is not intent", () => {
    const prefetch = mock<RouterContextValue["prefetch"]>(() => {
      /* noop */
    });
    const ctx = makeRouterContext({ prefetch });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { preload: false, to: "/blog" }, "Blog"),
      ctx
    );

    dispatchReactEvent(anchor, new FocusEvent("focusin", { bubbles: true }));

    expect(prefetch).not.toHaveBeenCalled();
    cleanup();
  });

  test("mouse enter calls custom onMouseEnter", () => {
    const onMouseEnter = mock<(e: React.MouseEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { onMouseEnter, to: "/blog" }, "Blog"),
      undefined
    );

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );

    expect(onMouseEnter).toHaveBeenCalled();
    cleanup();
  });

  test("mouse leave calls custom onMouseLeave", () => {
    const onMouseLeave = mock<(e: React.MouseEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { onMouseLeave, to: "/blog" }, "Blog"),
      undefined
    );

    dispatchReactEvent(
      anchor,
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
    );

    expect(onMouseLeave).toHaveBeenCalled();
    cleanup();
  });

  test("focus calls custom onFocus", () => {
    const onFocus = mock<(e: React.FocusEvent<HTMLAnchorElement>) => void>(() => {
      /* noop */
    });
    const { anchor, cleanup } = renderLink(
      createElement(Link, { onFocus, to: "/blog" }, "Blog"),
      undefined
    );

    dispatchReactEvent(anchor, new FocusEvent("focusin", { bubbles: true }));

    expect(onFocus).toHaveBeenCalled();
    cleanup();
  });

  // ── useRouter fallback (no provider) ─────────────────────────────────────────

  test("without RouterProvider, click falls back to window.location.href", () => {
    // Temporarily restore the real href setter so the fallback navigation works.
    if (originalHrefDescriptor) {
      Object.defineProperty(window.location, "href", originalHrefDescriptor);
    } else {
      // biome-ignore lint/performance/noDelete: removing an own property to restore prototype accessor behavior
      delete (window.location as unknown as { href?: unknown }).href;
    }

    const originalHref = window.location.href;
    const { anchor, cleanup } = renderLink(createElement(Link, { to: "/blog" }, "Blog"), undefined);

    dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    expect(window.location.href).toBe("http://localhost:3000/blog");
    cleanup();
    window.location.href = originalHref;
  });
});
