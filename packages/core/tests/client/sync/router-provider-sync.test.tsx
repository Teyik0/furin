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

type SyncEventListener = (event: Event) => void;

class FakeEventSource {
  static latest: FakeEventSource | undefined;

  listeners = new Map<string, SyncEventListener>();
  readyState = 0;
  url: string;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") {
      this.listeners.set(type, listener as SyncEventListener);
    }
  }

  close(): void {
    this.readyState = 2;
    FakeEventSource.latest = undefined;
  }

  emit(type: string, data: string): void {
    const listener = this.listeners.get(type);
    if (listener) {
      listener(new MessageEvent(type, { data }));
    }
  }

  open(): void {
    this.readyState = 1;
    this.listeners.get("open")?.(new Event("open"));
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function" && this.listeners.get(type) === listener) {
      this.listeners.delete(type);
    }
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
        syncStream: "/_furin/sync",
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
  let originalEventSource: typeof EventSource | undefined;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    installDom();
    resetDomState();
    window.history.replaceState(null, "", "/board");
    originalEventSource = globalThis.EventSource;
    originalFetch = globalThis.fetch;
    FakeEventSource.latest = undefined;
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  });

  afterEach(async () => {
    currentCleanup?.();
    currentCleanup = undefined;
    globalThis.fetch = originalFetch;
    if (originalEventSource === undefined) {
      Reflect.deleteProperty(globalThis, "EventSource");
    } else {
      globalThis.EventSource = originalEventSource;
    }
    await uninstallDom();
  });

  test("performs one initial catch-up read when the sync stream opens", async () => {
    const requested: string[] = [];
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/_furin/sync/changes") {
        requested.push(url.searchParams.get("after") ?? "initial");
        return Promise.resolve(
          Response.json({ changes: [], cursor: "0", hasMore: false, reset: false })
        );
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof globalThis.fetch;

    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    const { cleanup } = await renderRouter(route, initialMatch);
    currentCleanup = cleanup;

    await waitForDom(() => FakeEventSource.latest !== undefined, { timeoutMs: 2000 });
    expect(requested).toEqual([]);

    await act(async () => {
      FakeEventSource.latest?.open();
      await Promise.resolve();
    });

    await waitForDom(() => requested.length === 1, { timeoutMs: 100 });
    expect(requested).toEqual(["0"]);
  });

  test("refreshes the current page after an SSE sync event catches up through /changes", async () => {
    const requested = {
      changes: [] as string[],
      data: 0,
    };
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname === "/_furin/sync/changes") {
        requested.changes.push(url.searchParams.get("after") ?? "initial");
        const hasEvent = requested.changes.length >= 1;
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

    await waitForDom(() => FakeEventSource.latest !== undefined, { timeoutMs: 2000 });

    await act(async () => {
      FakeEventSource.latest?.emit("furin.sync", JSON.stringify({ cursor: "1" }));
      await Promise.resolve();
    });

    await waitForDom(() => container.textContent === "fresh", { timeoutMs: 2000 });

    expect(FakeEventSource.latest?.url).toBe("/_furin/sync");
    expect(requested.changes).toEqual(["0"]);
    expect(requested.data).toBe(1);
  });

  test("catches up when the sync stream reconnects without a notification", async () => {
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

    await waitForDom(() => FakeEventSource.latest !== undefined, { timeoutMs: 2000 });

    await act(async () => {
      FakeEventSource.latest?.open();
      await Promise.resolve();
    });
    expect(requested.changes).toEqual(["0"]);

    await act(async () => {
      FakeEventSource.latest?.open();
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

    await waitForDom(() => FakeEventSource.latest !== undefined, { timeoutMs: 2000 });
    expect(requested.changes).toEqual([]);
    await act(async () => {
      FakeEventSource.latest?.open();
      await Promise.resolve();
    });
    expect(requested.changes).toEqual(["0"]);

    await act(async () => {
      FakeEventSource.latest?.open();
      await Promise.resolve();
    });

    await waitForDom(() => container.textContent === "fresh", { timeoutMs: 2000 });

    expect(requested.changes).toEqual(["0", "0"]);
    expect(requested.data).toBe(1);
  });
});
