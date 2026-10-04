/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { Link, RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom, waitForDom } from "../../support/dom.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

const SCROLL_STORAGE_KEY = "__furin_scroll__";

function makePage(content: string, linkTo?: string): React.ComponentType<Record<string, unknown>> {
  return () =>
    createElement(
      "div",
      { style: { height: "2000px" } },
      content,
      linkTo ? createElement(Link, { to: linkTo }, `Go to ${linkTo}`) : null
    );
}

function makeRoute(path: string, content: string, linkTo?: string): ClientRoute {
  const Page = makePage(content, linkTo);
  return {
    load: async () => ({
      default: {
        _route: { layout: null } as never,
        component: Page,
      },
    }),
    pattern: path,
    regex: new RegExp(`^${path.replace(/\*/g, ".*")}$`),
  };
}

async function dispatchReactEvent(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
    await Promise.resolve();
  });
}

async function runHistoryUpdate(update: () => void): Promise<void> {
  await act(async () => {
    update();
    await Promise.resolve();
  });
}

async function flushReactUpdates(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Returns a single-line NDJSON response (CrossJSON-serialised) for the /_furin/data endpoint. */
function makeNdjsonResponse(data: Record<string, unknown>): Response {
  const ndjson = JSON.stringify(toCrossJSON(data));
  return new Response(ndjson, { headers: { "Content-Type": "application/x-ndjson" }, status: 200 });
}

interface RenderRouterResult {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

async function renderRouter(
  routes: ClientRoute[],
  initialPath: string | undefined
): Promise<RenderRouterResult> {
  const doc = (globalThis as unknown as { document: Document }).document;
  const container = doc.createElement("div");
  doc.body.appendChild(container);
  const root = createRoot(container);

  const win = globalThis as unknown as Window & typeof globalThis;
  const path = initialPath ?? "/";
  win.location.href = `http://localhost:3000${path}`;
  win.history.replaceState(null, "", path);

  let initialMatch:
    | (ClientRoute & {
        component: React.ComponentType<Record<string, unknown>>;
        pageRoute: unknown;
      })
    | null = null;
  const rawMatch = routes.find((r) => r.regex.test(path));
  if (rawMatch) {
    const mod = await rawMatch.load();
    initialMatch = {
      ...rawMatch,
      component: mod.default.component,
      pageRoute: mod.default._route,
    };
  }

  act(() => {
    root.render(
      createElement(RouterProvider, {
        autoRefresh: true,
        basePath: "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        initialData: {},
        initialDigest: undefined,
        initialMatch,
        initialNotFound: undefined,
        prefetchCacheSize: 50,
        root: null,
        routes,
      } as any)
    );
  });

  return {
    cleanup: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
      sessionStorage.removeItem(SCROLL_STORAGE_KEY);
    },
    container,
    root,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("scroll restoration on browser back", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalScrollY: PropertyDescriptor | undefined;
  let originalScrollTo: typeof window.scrollTo;
  let scrollPositions: Array<{ top: number; behavior?: ScrollBehavior }> = [];
  let currentScrollY = 0;

  beforeEach(() => {
    installDom();
    resetDomState();
    const win = globalThis as unknown as Window & typeof globalThis;
    originalFetch = globalThis.fetch;
    originalScrollY = Object.getOwnPropertyDescriptor(win, "scrollY");
    originalScrollTo = win.scrollTo;
    scrollPositions = [];
    currentScrollY = 0;

    // Mock sessionStorage to avoid happy-dom quirks
    const storage: Record<string, string> = {};
    Object.defineProperty(win, "sessionStorage", {
      configurable: true,
      value: {
        getItem: (key: string) => storage[key] ?? null,
        removeItem: (key: string) => {
          delete storage[key];
        },
        setItem: (key: string, value: string) => {
          storage[key] = value;
        },
      },
    });

    // Mock window.scrollY as a mutable getter
    Object.defineProperty(win, "scrollY", {
      configurable: true,
      get: () => currentScrollY,
    });

    // Mock window.scrollTo to capture calls
    win.scrollTo = mock((options: ScrollToOptions | number, _y?: number) => {
      if (typeof options === "object") {
        scrollPositions.push({ behavior: options.behavior, top: options.top ?? 0 });
        currentScrollY = options.top ?? 0;
      } else if (typeof options === "number" && typeof _y === "number") {
        scrollPositions.push({ top: _y });
        currentScrollY = _y;
      }
    }) as typeof win.scrollTo;

    // Mock fetch to return valid NDJSON with loader data for /_furin/data
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(
        input.toString(),
        (globalThis as unknown as Window & typeof globalThis).location.origin
      );
      const logicalPath =
        url.pathname === "/_furin/data" ? (url.searchParams.get("path") ?? "") : url.pathname;

      if (logicalPath === "/page-a") {
        return makeNdjsonResponse({ message: "page-a" });
      }
      if (logicalPath === "/page-b") {
        return makeNdjsonResponse({ message: "page-b" });
      }
      if (logicalPath === "/page-c") {
        return makeNdjsonResponse({ message: "page-c" });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof globalThis.fetch;
  });

  afterEach(async () => {
    const win = globalThis as unknown as Window & typeof globalThis;
    globalThis.fetch = originalFetch;

    if (originalScrollY) {
      Object.defineProperty(win, "scrollY", originalScrollY);
    } else {
      // biome-ignore lint/performance/noDelete: restoring original descriptor
      delete (win as { scrollY?: number }).scrollY;
    }

    win.scrollTo = originalScrollTo;
    await uninstallDom();
  });

  test("restores scroll position on browser back button", async () => {
    const routes = [makeRoute("/page-a", "Page A", "/page-b"), makeRoute("/page-b", "Page B")];
    const { cleanup, container } = await renderRouter(routes, "/page-a");

    // 1. Scroll down on Page A
    currentScrollY = 500;

    const win = globalThis as unknown as Window & typeof globalThis;

    // 2. Click Link to Page B (this should save scroll position before pushState)
    const linkB = container.querySelector('a[href="/page-b"]') as HTMLAnchorElement;
    expect(linkB).not.toBeNull();

    await dispatchReactEvent(linkB, new MouseEvent("click", { bubbles: true, cancelable: true }));

    await waitForDom(
      () => win.location.pathname === "/page-b" && container.textContent?.includes("Page B"),
      undefined
    );
    await flushReactUpdates();
    expect(currentScrollY).toBe(0);

    // 4. Simulate browser back button
    await runHistoryUpdate(() => win.history.back());

    await waitForDom(
      () => win.location.pathname === "/page-a" && container.textContent?.includes("Page A"),
      undefined
    );
    await flushReactUpdates();

    // 5. Verify we're back on Page A and scroll is restored
    expect(win.location.pathname).toBe("/page-a");
    expect(currentScrollY).toBe(500);

    cleanup();
  });

  test("scrolls to top on forward navigation by default", async () => {
    const win = globalThis as unknown as Window & typeof globalThis;
    const routes = [makeRoute("/page-a", "Page A", "/page-b"), makeRoute("/page-b", "Page B")];
    const { cleanup, container } = await renderRouter(routes, "/page-a");

    currentScrollY = 300;

    const linkB = container.querySelector('a[href="/page-b"]') as HTMLAnchorElement;
    await dispatchReactEvent(linkB, new MouseEvent("click", { bubbles: true, cancelable: true }));

    await waitForDom(
      () => win.location.pathname === "/page-b" && container.textContent?.includes("Page B"),
      undefined
    );
    await flushReactUpdates();

    expect(win.location.pathname).toBe("/page-b");
    expect(currentScrollY).toBe(0);

    cleanup();
  });

  test("preserves scroll position across history entry lifecycle", async () => {
    const win = globalThis as unknown as Window & typeof globalThis;
    const routes = [
      makeRoute("/page-a", "Page A", "/page-b"),
      makeRoute("/page-b", "Page B", "/page-c"),
      makeRoute("/page-c", "Page C"),
    ];
    const { cleanup, container } = await renderRouter(routes, "/page-a");

    // Navigate A -> B (scroll 100)
    currentScrollY = 100;
    const linkB = container.querySelector('a[href="/page-b"]') as HTMLAnchorElement;
    await dispatchReactEvent(linkB, new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForDom(
      () => win.location.pathname === "/page-b" && container.textContent?.includes("Page B"),
      undefined
    );
    await flushReactUpdates();

    // Scroll down on Page B to 200
    currentScrollY = 200;

    // Navigate B -> C
    const linkC = container.querySelector('a[href="/page-c"]') as HTMLAnchorElement;
    await dispatchReactEvent(linkC, new MouseEvent("click", { bubbles: true, cancelable: true }));
    await waitForDom(
      () => win.location.pathname === "/page-c" && container.textContent?.includes("Page C"),
      undefined
    );
    await flushReactUpdates();

    expect(win.location.pathname).toBe("/page-c");

    // Back to B
    await runHistoryUpdate(() => win.history.back());
    await waitForDom(
      () => win.location.pathname === "/page-b" && container.textContent?.includes("Page B"),
      undefined
    );
    await flushReactUpdates();
    expect(currentScrollY).toBe(200);

    // Back to A
    await runHistoryUpdate(() => win.history.back());
    await waitForDom(
      () => win.location.pathname === "/page-a" && container.textContent?.includes("Page A"),
      undefined
    );
    await flushReactUpdates();
    expect(currentScrollY).toBe(100); // Position when we left A

    cleanup();
  });

  test("saves the scroll of the entry left by back and forward navigation", async () => {
    const routes = [makeRoute("/page-a", "Page A", "/page-b"), makeRoute("/page-b", "Page B")];
    const { cleanup, container } = await renderRouter(routes, "/page-a");
    const win = globalThis as unknown as Window & typeof globalThis;
    try {
      currentScrollY = 100;
      const link = container.querySelector('a[href="/page-b"]') as HTMLAnchorElement;
      await dispatchReactEvent(link, new MouseEvent("click", { bubbles: true, cancelable: true }));
      await waitForDom(() => container.textContent?.includes("Page B") === true, undefined);
      await flushReactUpdates();

      currentScrollY = 200;
      await runHistoryUpdate(() => win.history.back());
      await waitForDom(() => container.textContent?.includes("Page A") === true, undefined);
      await flushReactUpdates();
      expect(currentScrollY).toBe(100);

      currentScrollY = 300;
      await runHistoryUpdate(() => win.history.forward());
      await waitForDom(() => container.textContent?.includes("Page B") === true, undefined);
      await flushReactUpdates();
      expect(currentScrollY).toBe(200);

      await runHistoryUpdate(() => win.history.back());
      await waitForDom(() => container.textContent?.includes("Page A") === true, undefined);
      await flushReactUpdates();
      expect(currentScrollY).toBe(300);
    } finally {
      cleanup();
    }
  });
});
