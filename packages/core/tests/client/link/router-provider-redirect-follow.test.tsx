/// <reference lib="dom" />
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { Link, RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

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
  initialPath: string | undefined
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
    },
    container,
    root,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("RouterProvider server-side redirect follow", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalReplaceState: typeof window.history.replaceState | undefined;
  let replaceStateCalls: Array<{ url: string }> = [];
  let currentCleanup: (() => void) | undefined;
  let httpRedirect = false;
  let chainedRedirect = false;

  beforeEach(() => {
    installDom();
    resetDomState();
    originalFetch = globalThis.fetch;
    originalReplaceState =
      typeof window !== "undefined" && typeof window.history !== "undefined"
        ? window.history.replaceState
        : undefined;
    replaceStateCalls = [];
    currentCleanup = undefined;
    httpRedirect = false;
    chainedRedirect = false;

    globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString(), window.location.origin);
      const logicalPath =
        url.pathname === "/_furin/data" ? (url.searchParams.get("path") ?? "") : url.pathname;

      if (logicalPath === "/page-b") {
        if (httpRedirect) {
          expect(init?.redirect).toBe("manual");
          return Promise.resolve(
            new Response(null, { headers: { location: "/page-c" }, status: 302 })
          );
        }
        // Simulate a server-side redirect: /page-b -> /page-c
        return Promise.resolve(
          makeNdjsonResponse({ __furinRedirect: "/page-c", message: "redirected" })
        );
      }
      if (logicalPath === "/page-c") {
        if (chainedRedirect) {
          return Promise.resolve(
            new Response(null, { headers: { location: "/page-d" }, status: 302 })
          );
        }
        return Promise.resolve(makeNdjsonResponse({ message: "page-c" }));
      }
      if (logicalPath === "/page-d") {
        return Promise.resolve(makeNdjsonResponse({ message: "page-d" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    if (typeof window !== "undefined" && typeof window.history !== "undefined") {
      (window as Window & { history: History }).history.replaceState = mock(
        (_state: unknown, _unused: string, url?: string | URL | null) => {
          if (url) {
            replaceStateCalls.push({ url: String(url) });
            const win = globalThis as unknown as Window & typeof globalThis;
            win.location.href = `http://localhost:3000${url}`;
          }
        }
      ) as typeof window.history.replaceState;
    }
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    if (
      originalReplaceState &&
      typeof window !== "undefined" &&
      typeof window.history !== "undefined"
    ) {
      window.history.replaceState = originalReplaceState;
    }
    currentCleanup?.();
    currentCleanup = undefined;
    await uninstallDom();
  });

  test(
    "follows server-side redirect via __furinRedirect without crashing",
    async () => {
      const routes = [
        makeRoute("/page-a", "/page-b"),
        makeRoute("/page-b", "/page-a"),
        makeRoute("/page-c", "/page-a"),
      ];
      const { container, cleanup } = await renderRouterWithLink(routes, "/page-a");
      currentCleanup = cleanup;

      const anchor = container.querySelector("a") as HTMLAnchorElement;
      expect(anchor).not.toBeNull();

      // Clicking /page-b triggers a server redirect to /page-c.
      // Before the fix, the navigate callback reassigned a const variable
      // (newState), causing a ReferenceError that surfaced as a 500.
      await dispatchReactEvent(
        anchor,
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );

      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const interval = setInterval(() => {
          if (window.location.pathname === "/page-c") {
            clearInterval(interval);
            resolve();
          } else if (Date.now() - start > 2000) {
            clearInterval(interval);
            reject(new Error("Timed out waiting for redirect navigation"));
          }
        }, 10);
      });
      await flushReactUpdates();

      expect(window.location.pathname).toBe("/page-c");
    },
    { timeout: 5000 }
  );

  test("follows an HTTP guard redirect after the data fetch", async () => {
    httpRedirect = true;
    const routes = [
      makeRoute("/page-a", "/page-b"),
      makeRoute("/page-b", "/page-a"),
      makeRoute("/page-c", "/page-a"),
    ];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a");
    currentCleanup = cleanup;

    await dispatchReactEvent(
      container.querySelector("a") as HTMLAnchorElement,
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (window.location.pathname === "/page-c") {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 2000) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for HTTP guard redirect"));
        }
      }, 10);
    });
    await flushReactUpdates();
    expect(window.location.pathname).toBe("/page-c");
  });

  test("follows chained HTTP guard redirects", async () => {
    httpRedirect = true;
    chainedRedirect = true;
    const routes = [
      makeRoute("/page-a", "/page-b"),
      makeRoute("/page-b", "/page-a"),
      makeRoute("/page-c", "/page-a"),
      makeRoute("/page-d", "/page-a"),
    ];
    const { container, cleanup } = await renderRouterWithLink(routes, "/page-a");
    currentCleanup = cleanup;

    await dispatchReactEvent(
      container.querySelector("a") as HTMLAnchorElement,
      new MouseEvent("click", { bubbles: true, cancelable: true })
    );
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const interval = setInterval(() => {
        if (window.location.pathname === "/page-d") {
          clearInterval(interval);
          resolve();
        } else if (Date.now() - start > 2000) {
          clearInterval(interval);
          reject(new Error("Timed out waiting for chained guard redirects"));
        }
      }, 10);
    });
    await flushReactUpdates();
    expect(window.location.pathname).toBe("/page-d");
  });
});
