import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  buildRouterTree,
  type ClientRoute,
  type LoadedClientRoute,
  type RouterContextValue,
  RouterProvider,
} from "../../../src/client/link.tsx";
import type { ErrorProps } from "../../../src/shared/error.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const ROOT_PATH_RE = /^\/$/;

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

function ThrowOnRender(): React.ReactElement {
  throw new Error("boom");
}

function InitialErrorFallback({ error }: ErrorProps): React.ReactElement {
  return createElement("p", { "data-testid": "initial-error-message" }, error.message);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("buildRouterTree — error boundary fallback navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalHref: string;
  let locationSpy: { set: ReturnType<typeof mock> };

  beforeEach(() => {
    installDom();
    resetDomState();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalHref = window.location.href;
    locationSpy = { set: mock() };
    // The code under test writes `window.location.href = …`, not
    // `window.location = …`. The spy must therefore live on the `href` setter
    // of the object returned by the getter — a setter on `window.location`
    // itself never fires for `.href` assignments, making the spy a dead no-op.
    Object.defineProperty(window, "location", {
      configurable: true,
      get: () => ({
        get href() {
          return originalHref;
        },
        set href(v: string) {
          locationSpy.set(v);
        },
        origin: "http://localhost:3000",
        pathname: "/",
        search: "",
      }),
      set: locationSpy.set as unknown as (v: string) => void,
    });
  });

  afterEach(async () => {
    await act(() => {
      root.unmount();
    });
    container.remove();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { href: originalHref },
      writable: true,
    });
    await uninstallDom();
  });

  test("Link in default 500 fallback navigates via SPA (not full reload)", async () => {
    const navigateSpy = mock(() => Promise.resolve());
    const ctx = makeRouterContext({
      navigate: navigateSpy as unknown as RouterContextValue["navigate"],
    });

    const tree = buildRouterTree(ctx, createElement(ThrowOnRender), {});

    await act(() => {
      root.render(tree);
    });

    // The error boundary should have caught the throw and rendered DefaultErrorScreen
    const anchor = container.querySelector('a[href="/"]') as HTMLAnchorElement | null;
    expect(anchor).not.toBeNull();
    if (!anchor) {
      throw new Error("Anchor not found");
    }
    expect(anchor.textContent).toContain("Go Home");

    // Simulate a plain left-click (no modifiers)
    const clickEvent = new MouseEvent("click", {
      altKey: false,
      bubbles: true,
      button: 0,
      cancelable: true,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    anchor.dispatchEvent(clickEvent);

    // The Link should have used router.navigate() (SPA) instead of window.location.href (full reload)
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith("/", { replace: undefined, resetScroll: true });
    expect(locationSpy.set).not.toHaveBeenCalled();
  });

  test("a partial initial server error exposes a safe message to the route fallback", async () => {
    const pageRoute = { __type: "FURIN_ROUTE" as const };
    const route: ClientRoute = {
      load: async () => ({
        default: {
          _route: pageRoute,
          component: () => createElement("p", null, "page"),
        },
      }),
      pattern: "/",
      regex: ROOT_PATH_RE,
    };
    const initialMatch: LoadedClientRoute = {
      ...route,
      component: () => createElement("p", null, "page"),
      pageRoute,
      segmentBoundaries: [{ depth: 0, error: InitialErrorFallback }],
    };

    await act(() => {
      root.render(
        createElement(RouterProvider, {
          autoRefresh: true,
          basePath: "",
          defaultPreload: "intent",
          defaultPreloadDelay: 50,
          defaultPreloadStaleTime: 30_000,
          initialData: {},
          initialDigest: "abc1234567",
          initialError: { digest: "abc1234567", status: 500 },
          initialMatch,
          initialNotFound: undefined,
          prefetchCacheSize: 50,
          root: null,
          routes: [route],
        })
      );
    });

    expect(container.querySelector('[data-testid="initial-error-message"]')?.textContent).toBe(
      "Something went wrong"
    );
  });
});
