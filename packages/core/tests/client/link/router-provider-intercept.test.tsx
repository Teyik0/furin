/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { log } from "evlog";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import {
  DocumentProvider,
  type DocumentState,
  useDocumentState,
} from "../../../src/client/document.tsx";
import { Link, RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const CATCH_ALL_ROUTE_RE = /^\/(.*)$/;
const PAGE_B_RE = /^\/page-b$/;

// ── Helpers ───────────────────────────────────────────────────────────────────

function makePage(linkTo: string): React.ComponentType<Record<string, unknown>> {
  return () =>
    createElement(
      "div",
      { style: { height: "2000px" } },
      createElement(Link, { to: linkTo }, `Go to ${linkTo}`)
    );
}

function makeRoute(path: string, linkTo: string): ClientRoute {
  return {
    load: async () => ({
      default: {
        _route: { __type: "FURIN_ROUTE" } as never,
        component: makePage(linkTo),
      },
    }),
    pattern: path,
    regex: new RegExp(`^${path}$`),
  };
}

function makeCatchAllRoute(): ClientRoute {
  return {
    ...makeRoute("/*", "/"),
    regex: CATCH_ALL_ROUTE_RE,
  };
}

function DocumentHeadPage(): React.ReactElement {
  const state = useDocumentState();
  return createElement("p", { "data-document-head": "" }, JSON.stringify(state?.head));
}

/** Page rendering a plain `<a>` (MDX/CMS-style), which goes through the
 *  provider's document-level click interceptor instead of Furin Link. */
function makeNativeAnchorRoute(path: string, href: string): ClientRoute {
  return {
    load: async () => ({
      default: {
        _route: { __type: "FURIN_ROUTE" } as never,
        component: () => createElement("div", null, createElement("a", { href }, `Go to ${href}`)),
      },
    }),
    pattern: path,
    regex: new RegExp(`^${path}$`),
  };
}

async function dispatchReactEvent(target: EventTarget, event: Event): Promise<void> {
  await act(async () => {
    target.dispatchEvent(event);
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

async function renderRouterWithLink(
  routes: ClientRoute[],
  initialPath: string | undefined,
  documentState: DocumentState | undefined
): Promise<RenderRouterResult> {
  const container = document.createElement("div");
  document.body.appendChild(container);
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

  const router = createElement(RouterProvider, {
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
  } as any);
  await act(() => {
    root.render(
      documentState === undefined
        ? router
        : createElement(DocumentProvider, { value: documentState }, router)
    );
  });

  return {
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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RouterProvider click interception", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalPushState: typeof window.history.pushState | undefined;
  let pushStateCalls: Array<{ url: string }> = [];
  let currentCleanup: (() => void) | undefined;
  let abortFirstPageBRequest = false;
  let pageBRequests = 0;

  beforeEach(() => {
    installDom();
    resetDomState();
    originalFetch = globalThis.fetch;
    originalPushState =
      typeof window !== "undefined" && typeof window.history !== "undefined"
        ? window.history.pushState
        : undefined;
    pushStateCalls = [];
    currentCleanup = undefined;
    abortFirstPageBRequest = false;
    pageBRequests = 0;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString(), window.location.origin);
      const logicalPath =
        url.pathname === "/_furin/data" ? (url.searchParams.get("path") ?? "") : url.pathname;

      if (logicalPath === "/page-b") {
        pageBRequests += 1;
        if (abortFirstPageBRequest && pageBRequests === 1) {
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                const error = new Error("signal is aborted without reason");
                error.name = "AbortError";
                reject(error);
              },
              { once: true }
            );
          });
        }
        return Promise.resolve(makeNdjsonResponse({ message: "page-b" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    if (typeof window !== "undefined" && typeof window.history !== "undefined") {
      (window as Window & { history: History }).history.pushState = mock(
        (_state: unknown, _unused: string, url?: string | URL | null) => {
          if (url) {
            pushStateCalls.push({ url: String(url) });
            const win = globalThis as unknown as Window & typeof globalThis;
            win.location.href = `http://localhost:3000${url}`;
          }
        }
      ) as typeof window.history.pushState;
    }
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (originalPushState) {
      window.history.pushState = originalPushState;
    }
    currentCleanup?.();
    currentCleanup = undefined;
    await uninstallDom();
  });

  test("click on Furin Link triggers history.pushState exactly once", async () => {
    const routes = [makeRoute("/page-a", "/page-b"), makeRoute("/page-b", "/page-a")];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a", undefined);
    currentCleanup = cleanup;

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();

    await dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (pushStateCalls.length === 1 || window.location.pathname === "/page-b") {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 2000) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for navigation"));
        }
      }, 10);
    });
    await flushReactUpdates();

    expect(pushStateCalls.length).toBe(1);
    expect(pushStateCalls[0]?.url).toBe("/page-b");
  });

  test("navigation to a route without head clears the initial document head", async () => {
    const pageB: ClientRoute = {
      load: async () => ({
        default: {
          _route: { __type: "FURIN_ROUTE" } as never,
          component: DocumentHeadPage,
        },
      }),
      pattern: "/page-b",
      regex: PAGE_B_RE,
    };
    const documentState: DocumentState = {
      assets: {
        buildId: undefined,
        entryModule: undefined,
        faviconHref: undefined,
        staticMode: false,
        stylesheets: [],
      },
      dataJson: undefined,
      head: { meta: [{ title: "Initial title" }] },
      syncJson: undefined,
    };
    const { container, cleanup } = await renderRouterWithLink(
      [makeRoute("/page-a", "/page-b"), pageB],
      "/page-a",
      documentState
    );
    currentCleanup = cleanup;

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    await dispatchReactEvent(anchor, new MouseEvent("click", { bubbles: true, cancelable: true }));
    await flushReactUpdates();

    expect(container.querySelector("[data-document-head]")?.textContent).toBe("");
  });

  test("superseding a Link navigation does not leak an AbortError", async () => {
    const errorLog = spyOn(log, "error");
    const waitFor = (condition: () => boolean) =>
      new Promise<void>((resolve, reject) => {
        const startedAt = Date.now();
        const interval = setInterval(() => {
          if (condition()) {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - startedAt > 2000) {
            clearInterval(interval);
            reject(new Error("Timed out waiting for navigation"));
          }
        }, 10);
      });

    try {
      abortFirstPageBRequest = true;
      const routes = [makeRoute("/page-a", "/page-b"), makeRoute("/page-b", "/page-a")];
      const { container, cleanup } = await renderRouterWithLink(routes, "/page-a", undefined);
      currentCleanup = cleanup;
      const anchor = container.querySelector("a") as HTMLAnchorElement;

      await dispatchReactEvent(
        anchor,
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      await waitFor(() => pageBRequests === 1);
      await dispatchReactEvent(
        anchor,
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      await waitFor(() => pageBRequests === 2 && window.location.pathname === "/page-b");
      await flushReactUpdates();

      expect(pageBRequests).toBe(2);
      expect(window.location.pathname).toBe("/page-b");
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  /** Clicks `anchor` with a trailing document-level listener (registered after
   *  the provider's interceptor) that records whether the provider called
   *  preventDefault, then prevents default itself so happy-dom never performs
   *  a real navigation. */
  async function clickNativeAnchor(anchor: HTMLAnchorElement): Promise<boolean> {
    let preventedByProvider = false;
    const guard = (e: Event) => {
      preventedByProvider = e.defaultPrevented;
      e.preventDefault();
    };
    document.addEventListener("click", guard);
    try {
      await dispatchReactEvent(
        anchor,
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
    } finally {
      document.removeEventListener("click", guard);
    }
    return preventedByProvider;
  }

  test("native <a> matching a local route is intercepted as SPA navigation", async () => {
    const routes = [makeNativeAnchorRoute("/page-a", "/page-b"), makeRoute("/page-b", "/page-a")];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a", undefined);
    currentCleanup = cleanup;

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();

    const intercepted = await clickNativeAnchor(anchor);
    expect(intercepted).toBe(true);

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (pushStateCalls.length === 1) {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 2000) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for navigation"));
        }
      }, 10);
    });
    await flushReactUpdates();

    expect(pushStateCalls.length).toBe(1);
    expect(pushStateCalls[0]?.url).toBe("/page-b");
  });

  test("native <a> to a sibling app bypasses a local catch-all route", async () => {
    // The root app's catch-all must not claim /admin: that path belongs to a
    // sibling furin app mounted under another prefix.
    const routes = [
      makeNativeAnchorRoute("/page-a", "/admin"),
      makeRoute("/page-b", "/page-a"),
      makeCatchAllRoute(),
    ];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a", undefined);
    currentCleanup = cleanup;

    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor).not.toBeNull();

    const intercepted = await clickNativeAnchor(anchor);
    await flushReactUpdates();

    expect(intercepted).toBe(false);
    expect(pushStateCalls.length).toBe(0);
  });
});
