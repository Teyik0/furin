/// <reference lib="dom" />
import "../../setup/global.ts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute, LoadedClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom, waitForDom } from "../../support/dom.ts";

interface PageProps {
  message?: unknown;
  [key: string]: unknown;
}

interface RenderedRouter {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

const BROWSER_EVENTS_RUNTIME_KEY = Symbol.for("furin.browser-events.runtime");

interface SyncBrowserEvent {
  channel: "sync";
  data: { cursor: string };
  version: 1;
}

class FakeBrowserEvents {
  listener: ((event: SyncBrowserEvent) => void) | undefined;

  emit(cursor: string): void {
    this.listener?.({ channel: "sync", data: { cursor }, version: 1 });
  }

  subscribe(channel: string, listener: (event: SyncBrowserEvent) => void): () => void {
    if (channel === "sync") {
      this.listener = listener;
    }
    return () => {
      if (this.listener === listener) {
        this.listener = undefined;
      }
    };
  }
}

function Page(props: PageProps): React.ReactElement {
  return createElement("main", { "data-message": String(props.message) }, String(props.message));
}

function makeRoute(path: string): ClientRoute {
  return {
    load: async () => ({
      default: {
        _route: { __type: "FURIN_ROUTE" } as never,
        component: Page,
      },
    }),
    pattern: path,
    regex: new RegExp(`^${path}$`),
  };
}

function makeNdjsonResponse(data: PageProps): Response {
  return new Response(`${JSON.stringify(toCrossJSON(data))}\n`, {
    headers: { "Content-Type": "application/x-ndjson" },
    status: 200,
  });
}

async function loadInitialMatch(route: ClientRoute): Promise<LoadedClientRoute> {
  const mod = await route.load();
  return {
    ...route,
    component: mod.default.component,
    pageRoute: mod.default._route,
  };
}

async function renderRouter(
  route: ClientRoute,
  initialMatch: LoadedClientRoute
): Promise<RenderedRouter> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(RouterProvider, {
        autoRefresh: true,
        basePath: "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        initialData: { message: "stale" },
        initialDigest: undefined,
        initialError: undefined,
        initialMatch,
        initialNotFound: undefined,
        prefetchCacheSize: 50,
        root: null,
        routes: [route],
        syncPath: "/_furin/sync",
      })
    );
    await Promise.resolve();
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

describe("RouterProvider sync refresh", () => {
  let currentCleanup: (() => void) | undefined;
  let browserEvents: FakeBrowserEvents;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    installDom();
    resetDomState();
    window.history.replaceState(null, "", "/board");
    originalFetch = globalThis.fetch;
    browserEvents = new FakeBrowserEvents();
    (globalThis as typeof globalThis & { [key: symbol]: FakeBrowserEvents })[
      BROWSER_EVENTS_RUNTIME_KEY
    ] = browserEvents;
  });

  afterEach(async () => {
    currentCleanup?.();
    currentCleanup = undefined;
    globalThis.fetch = originalFetch;
    Reflect.deleteProperty(globalThis, BROWSER_EVENTS_RUNTIME_KEY);
    await uninstallDom();
  });

  test("performs one initial catch-up read from the WebSocket cursor", async () => {
    const requested: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/_furin/sync/changes") {
        requested.push(url.searchParams.get("after") ?? "initial");
        return Promise.resolve(
          Response.json({ changes: [], cursor: "12", hasMore: false, reset: false })
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    const { cleanup } = await renderRouter(route, initialMatch);
    currentCleanup = cleanup;

    await waitForDom(() => browserEvents.listener !== undefined, { timeoutMs: 2000 });
    expect(requested).toEqual([]);

    await act(async () => {
      browserEvents.emit("12");
      await Promise.resolve();
    });

    await waitForDom(() => requested.length === 1, { timeoutMs: 100 });
    expect(requested).toEqual(["12"]);
  });

  test("refreshes the current page after a sync event catches up through /changes", async () => {
    const requested = {
      changes: [] as string[],
      data: 0,
    };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/_furin/sync/changes") {
        requested.changes.push(url.searchParams.get("after") ?? "initial");
        const hasEvent = requested.changes.length >= 2;
        return Promise.resolve(
          Response.json({
            changes: hasEvent ? [{ cursor: "1", invalidations: ["/board"] }] : [],
            cursor: hasEvent ? "1" : "0",
            hasMore: false,
            reset: false,
          })
        );
      }
      if (url.pathname === "/_furin/data") {
        requested.data += 1;
        return Promise.resolve(makeNdjsonResponse({ message: "fresh" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    const { cleanup, container } = await renderRouter(route, initialMatch);
    currentCleanup = cleanup;

    await waitForDom(() => browserEvents.listener !== undefined, { timeoutMs: 2000 });

    await act(async () => {
      browserEvents.emit("0");
      await Promise.resolve();
    });
    await act(async () => {
      browserEvents.emit("1");
      await Promise.resolve();
    });

    await waitForDom(() => container.textContent === "fresh", { timeoutMs: 2000 });

    expect(requested.changes).toEqual(["0", "0"]);
    expect(requested.data).toBe(1);
  });

  test("catches up when browser events reconnect without a new mutation", async () => {
    const requested = {
      changes: [] as string[],
      data: 0,
    };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/_furin/sync/changes") {
        requested.changes.push(url.searchParams.get("after") ?? "initial");
        const hasEvent = requested.changes.length >= 2;
        return Promise.resolve(
          Response.json({
            changes: hasEvent ? [{ cursor: "1", invalidations: ["/board"] }] : [],
            cursor: hasEvent ? "1" : "0",
            hasMore: false,
            reset: false,
          })
        );
      }
      if (url.pathname === "/_furin/data") {
        requested.data += 1;
        return Promise.resolve(makeNdjsonResponse({ message: "fresh" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    const { cleanup, container } = await renderRouter(route, initialMatch);
    currentCleanup = cleanup;

    await waitForDom(() => browserEvents.listener !== undefined, { timeoutMs: 2000 });

    await act(async () => {
      browserEvents.emit("0");
      await Promise.resolve();
    });
    expect(requested.changes).toEqual(["0"]);

    await act(async () => {
      browserEvents.emit("1");
      await Promise.resolve();
    });

    await waitForDom(() => requested.changes.length === 2, { timeoutMs: 100 });
    await waitForDom(() => container.textContent === "fresh", { timeoutMs: 2000 });

    expect(requested.changes).toEqual(["0", "0"]);
    expect(requested.data).toBe(1);
  });

  test("catches up on reconnect after the initial read fails", async () => {
    const requested = {
      changes: [] as string[],
      data: 0,
    };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/_furin/sync/changes") {
        requested.changes.push(url.searchParams.get("after") ?? "initial");
        if (requested.changes.length === 1) {
          return Promise.reject(new Error("Sync journal temporarily unavailable"));
        }
        return Promise.resolve(
          Response.json({
            changes: [{ cursor: "1", invalidations: ["/board"] }],
            cursor: "1",
            hasMore: false,
            reset: false,
          })
        );
      }
      if (url.pathname === "/_furin/data") {
        requested.data += 1;
        return Promise.resolve(makeNdjsonResponse({ message: "fresh" }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    const { cleanup, container } = await renderRouter(route, initialMatch);
    currentCleanup = cleanup;

    await waitForDom(() => browserEvents.listener !== undefined, { timeoutMs: 2000 });
    await act(async () => {
      browserEvents.emit("0");
      await Promise.resolve();
    });
    expect(requested.changes).toEqual(["0"]);

    await act(async () => {
      browserEvents.emit("1");
      await Promise.resolve();
    });

    await waitForDom(() => container.textContent === "fresh", { timeoutMs: 2000 });

    expect(requested.changes).toEqual(["0", "0"]);
    expect(requested.data).toBe(1);
  });
});
