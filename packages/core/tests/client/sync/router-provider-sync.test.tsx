/// <reference lib="dom" />
import "../../setup/global.ts";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { act, createElement, Suspense, use } from "react";
import { createRoot, type Root } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import type { ClientRoute, LoadedClientRoute } from "../../../src/client/router/index.ts";
import { useQuery, withSync } from "../../../src/client.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { serializeRouteFrame, serializeRouteFrames } from "../../../src/shared/route-frame.ts";
import { installDom, resetDomState, uninstallDom, waitForDom } from "../../support/dom.ts";

interface PageProps {
  message?: unknown;
  [key: string]: unknown;
}

declare module "@teyik0/furin/routes" {
  interface RoutePatternMap {
    "/optimistic-board/:boardId": { loader: () => { message: string } };
  }
}

interface RenderedRouter {
  cleanup: () => void;
  container: HTMLDivElement;
  root: Root;
}

const BROWSER_EVENTS_RUNTIME_KEY = Symbol.for("furin.browser-events.runtime");
const OPTIMISTIC_BOARD_REGEX = /^\/optimistic-board\/[^/]+$/;

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
  initialMatch: LoadedClientRoute,
  initialData?: PageProps,
  routes?: ClientRoute[],
  basePath?: string
): Promise<RenderedRouter> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(RouterProvider, {
        autoRefresh: true,
        basePath: basePath ?? "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        initialData: initialData ?? { message: "stale" },
        initialDigest: undefined,
        initialError: undefined,
        initialMatch,
        initialNotFound: undefined,
        prefetchCacheSize: 50,
        root: null,
        routes: routes ?? [route],
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

  test("one GET projection updates loader props and holds a scoped refresh until the write settles", async () => {
    const gate = Promise.withResolvers<void>();
    let count = 0;
    let reads = 0;
    let loaderReads = 0;
    let changesRead = false;
    const identity = { id: "board.count", scope: { boardId: "alpha" }, session: "test" };
    const app = new Elysia()
      .get("/count", ({ set }) => {
        reads += 1;
        set.headers["x-furin-query"] = JSON.stringify(identity);
        return { count };
      })
      .post("/count", async () => {
        count += 1;
        await gate.promise;
        return { ok: true };
      });
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    function Counter(props: PageProps) {
      const countData = props.countData as { count: number };
      return <main>{countData.count}</main>;
    }
    const seed = () => [
      {
        url: `${window.location.origin}/count`,
        data: { count },
        identity,
        bindings: [{ target: ["countData"], source: [] }],
      },
    ];
    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    initialMatch.component = Counter;
    route.load = async () => ({
      default: { component: Counter, _route: { __type: "FURIN_ROUTE" } as never },
    });
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      if (String(input).includes("/changes")) {
        changesRead = true;
        return Promise.resolve(
          Response.json({
            cursor: "1",
            hasMore: false,
            reset: false,
            changes: [{ cursor: "1", invalidations: [], queries: [identity] }],
          })
        );
      }
      loaderReads += 1;
      return Promise.resolve(makeNdjsonResponse({ countData: { count }, __furinQueries: seed() }));
    }) as unknown as typeof fetch;
    const rendered = await renderRouter(route, initialMatch, {
      countData: { count },
      __furinQueries: seed(),
    });
    currentCleanup = rendered.cleanup;
    expect(rendered.container.textContent).toBe("0");
    expect(reads).toBe(0);
    let write: ReturnType<typeof api.count.post>;
    try {
      await act(async () => {
        write = api.count.post(undefined, {
          optimistic: (cache) => cache.update(api.count.get, (data) => ({ count: data.count + 1 })),
        });
        await Promise.resolve();
      });
      expect(rendered.container.textContent).toBe("1");
      await act(async () => {
        browserEvents.emit("0");
        await waitForDom(() => changesRead, { timeoutMs: 2000 });
      });
      expect(loaderReads).toBe(0);
      await act(async () => {
        gate.resolve();
        await write;
      });
      expect(rendered.container.textContent).toBe("1");
      expect(loaderReads).toBeGreaterThan(0);
    } finally {
      gate.resolve();
    }
  });

  test("an opaque journal reset refreshes observed GETs and the current route", async () => {
    const identity = { id: "board.count", scope: { boardId: "alpha" }, session: "test" };
    let count = 0;
    let reads = 0;
    let loaderReads = 0;
    const app = new Elysia().get("/count", ({ set }) => {
      reads += 1;
      set.headers["x-furin-query"] = JSON.stringify(identity);
      return { count };
    });
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    function Counter(props: PageProps) {
      return <main>{`${props.message}:${useQuery(api.count.get).data?.count}`}</main>;
    }
    const seed = () => [{ url: `${window.location.origin}/count`, identity, data: { count } }];
    const route = makeRoute("/board");
    route.load = async () => ({
      default: { component: Counter, _route: { __type: "FURIN_ROUTE" } as never },
    });
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      if (String(input).includes("/changes")) {
        return Promise.resolve(
          Response.json({ changes: [], cursor: "1", hasMore: false, reset: true })
        );
      }
      loaderReads += 1;
      return Promise.resolve(makeNdjsonResponse({ message: "After", __furinQueries: seed() }));
    }) as unknown as typeof fetch;
    const rendered = await renderRouter(route, await loadInitialMatch(route), {
      message: "Before",
      __furinQueries: seed(),
    });
    currentCleanup = rendered.cleanup;
    expect(rendered.container.textContent).toBe("Before:0");
    expect(reads).toBe(0);
    count = 1;
    await act(async () => {
      browserEvents.emit("0");
      await Bun.sleep(0);
    });
    expect(rendered.container.textContent).toBe("After:1");
    expect(reads).toBe(1);
    expect(loaderReads).toBe(1);
  });

  test("a streamed private GET updates promise props optimistically, rolls back, and refreshes on sync", async () => {
    const writeGate = Promise.withResolvers<void>();
    const identity = { id: "board.count", scope: { boardId: "alpha" }, session: "test" };
    let reads = 0;
    let loaderReads = 0;
    let changesRead = false;
    const app = new Elysia()
      .get("/count", ({ set }) => {
        reads += 1;
        set.headers["x-furin-query"] = JSON.stringify(identity);
        return { count: 0 };
      })
      .post("/count", async () => {
        await writeGate.promise;
        return new Response("Rejected", { status: 500 });
      });
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    function Value({ data }: { data: Promise<{ count: number }> }) {
      return <main>{use(data).count}</main>;
    }
    function Counter(props: PageProps) {
      return (
        <Suspense fallback="pending">
          <Value data={props.privateData as Promise<{ count: number }>} />
        </Suspense>
      );
    }
    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    initialMatch.component = Counter;
    route.load = async () => ({
      default: { component: Counter, _route: { __type: "FURIN_ROUTE" } as never },
    });
    const encoder = new TextEncoder();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
        controller.enqueue(encoder.encode(serializeRouteFrames({}, ["privateData"])));
      },
    });
    const parsed = await parseDeferredNdjson(stream, undefined);
    globalThis.fetch = mock((input: RequestInfo | URL) => {
      if (String(input).includes("/changes")) {
        changesRead = true;
        return Promise.resolve(
          Response.json({
            cursor: "1",
            hasMore: false,
            reset: false,
            changes: [{ cursor: "1", invalidations: [], queries: [identity] }],
          })
        );
      }
      loaderReads += 1;
      return Promise.resolve(
        new Response(
          serializeRouteFrames(
            {
              __furinQueries: [
                {
                  url: `${window.location.origin}/count`,
                  identity,
                  data: { count: 0 },
                  bindings: [{ source: [], target: ["privateData"] }],
                },
              ],
            },
            ["privateData"]
          ) +
            serializeRouteFrame({
              type: "defer-resolve",
              key: "privateData",
              value: toCrossJSON({ count: 0 }),
            }),
          { headers: { "Content-Type": "application/x-ndjson" } }
        )
      );
    }) as unknown as typeof fetch;
    const rendered = await renderRouter(route, initialMatch, {
      ...parsed.syncData,
      ...parsed.deferredPromises,
    });
    currentCleanup = rendered.cleanup;
    expect(rendered.container.textContent).toBe("pending");
    try {
      await act(async () => {
        streamController?.enqueue(
          encoder.encode(
            serializeRouteFrame({
              type: "defer-resolve",
              key: "privateData",
              value: toCrossJSON({ count: 0 }),
              queries: toCrossJSON([
                {
                  url: `${window.location.origin}/count`,
                  identity,
                  data: { count: 0 },
                  bindings: [{ source: [], target: ["privateData"] }],
                },
              ]),
            })
          )
        );
        streamController?.close();
        await parsed.deferredPromises.privateData;
      });
      expect(rendered.container.textContent).toBe("0");
      expect(reads).toBe(0);
      let write: ReturnType<typeof api.count.post>;
      await act(async () => {
        write = api.count.post(undefined, {
          optimistic: (cache) => cache.update(api.count.get, (data) => ({ count: data.count + 1 })),
        });
        await Promise.resolve();
      });
      expect(rendered.container.textContent).toBe("1");
      await act(async () => {
        browserEvents.emit("0");
        await waitForDom(() => changesRead, { timeoutMs: 2000 });
      });
      expect(loaderReads).toBe(0);
      await act(async () => {
        writeGate.resolve();
        await write;
      });
      expect(rendered.container.textContent).toBe("0");
      expect(loaderReads).toBeGreaterThan(0);
    } finally {
      writeGate.resolve();
    }
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

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/board": {
      loader: () => { message: string };
      elysia: { "~Routes": { get: { query: { filter?: string } } } };
    };
    "/other": { loader: () => { message: string } };
  }
}

describe("Eden optimistic loader projection", () => {
  let cleanup: (() => void) | undefined;
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    installDom();
    resetDomState();
    window.history.replaceState(null, "", "/board");
    originalFetch = globalThis.fetch;
  });
  afterEach(async () => {
    cleanup?.();
    cleanup = undefined;
    globalThis.fetch = originalFetch;
    await uninstallDom();
  });

  test("a mutation finishing after unmount does not refresh the removed router", async () => {
    const gate = Promise.withResolvers<void>();
    const app = new Elysia().post("/cards", async () => {
      await gate.promise;
      return { ok: true };
    });
    let refreshes = 0;
    globalThis.fetch = (() => {
      refreshes += 1;
      return Promise.resolve(makeNdjsonResponse({ message: "saved" }));
    }) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/board");
    const rendered = await renderRouter(route, await loadInitialMatch(route));
    let call: ReturnType<typeof api.cards.post> | undefined;
    await act(async () => {
      call = api.cards.post(undefined, {
        optimistic: (cache) =>
          cache.update("/board", (loader) => ({ ...loader, message: "saved" })),
      });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toBe("saved");
    rendered.cleanup();
    await act(async () => {
      gate.resolve();
      await call;
    });
    expect(refreshes).toBe(0);
  });
  test("renders optimistic props without local state and hands off to confirmed data", async () => {
    const mutationGate = Promise.withResolvers<void>();
    const refreshGate = Promise.withResolvers<void>();
    const app = new Elysia().post("/cards", async () => {
      await mutationGate.promise;
      return { ok: true };
    });
    globalThis.fetch = (async () => {
      await refreshGate.promise;
      return makeNdjsonResponse({ message: "saved" });
    }) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/board");
    const rendered = await renderRouter(route, await loadInitialMatch(route));
    ({ cleanup } = rendered);

    let mutation: ReturnType<typeof api.cards.post> | undefined;
    await act(async () => {
      mutation = api.cards.post(undefined, {
        optimistic: (cache) =>
          cache.update("/board", (loader) => ({ ...loader, message: "saved" })),
      });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toBe("saved");
    await act(async () => {
      mutationGate.resolve();
      await mutation;
    });
    expect(rendered.container.textContent).toBe("saved");
    await act(async () => {
      refreshGate.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(rendered.container.textContent).toBe("saved");
  });
  test("removes only the failed operation while another optimistic mutation is pending", async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const app = new Elysia().post("/cards/:id", async ({ params }) => {
      if (params.id === "first") {
        await first.promise;
        return Response.json({ message: "rejected" }, { status: 422 });
      }
      await second.promise;
      return { ok: true };
    });
    globalThis.fetch = (async () =>
      makeNdjsonResponse({ message: "10" })) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/board");
    const rendered = await renderRouter(route, await loadInitialMatch(route), { message: "0" });
    ({ cleanup } = rendered);
    let firstCall: ReturnType<ReturnType<typeof api.cards>["post"]> | undefined;
    let secondCall: typeof firstCall;
    await act(async () => {
      firstCall = api.cards({ id: "first" }).post(undefined, {
        optimistic: (cache) =>
          cache.update("/board", (loader) => ({
            ...loader,
            message: String(Number(loader.message) + 1),
          })),
      });
      secondCall = api.cards({ id: "second" }).post(undefined, {
        optimistic: (cache) =>
          cache.update("/board", (loader) => ({
            ...loader,
            message: String(Number(loader.message) + 10),
          })),
      });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toBe("11");
    await act(async () => {
      first.resolve();
      await firstCall;
    });
    expect(rendered.container.textContent).toBe("10");
    await act(async () => {
      second.resolve();
      await secondCall;
    });
    await waitForDom(() => rendered.container.textContent === "10", { timeoutMs: 2000 });
    expect(rendered.container.textContent).toBe("10");
  });

  test.each([200, 409])(
    "shares optimism for concurrent calls with the same explicit key (%s)",
    async (duplicateStatus) => {
      const gate = Promise.withResolvers<void>();
      let requests = 0;
      let callbacks = 0;
      const app = new Elysia().post("/cards", async () => {
        requests += 1;
        if (requests === 2) {
          return Response.json(
            { code: "FURIN_MUTATION_PAYLOAD_MISMATCH" },
            { status: duplicateStatus }
          );
        }
        await gate.promise;
        return { ok: true };
      });
      globalThis.fetch = (async () =>
        makeNdjsonResponse({ message: "1" })) as unknown as typeof fetch;
      const api = withSync(
        treaty<typeof app>(window.location.origin, {
          fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
        })
      );
      const route = makeRoute("/board");
      const rendered = await renderRouter(route, await loadInitialMatch(route), { message: "0" });
      ({ cleanup } = rendered);
      const options = {
        headers: { "Idempotency-Key": "shared" },
        optimistic(cache: import("../../../src/client.ts").OptimisticCache) {
          callbacks += 1;
          cache.update("/board", (loader) => ({
            ...loader,
            message: String(Number(loader.message) + 1),
          }));
        },
      };
      let first: ReturnType<typeof api.cards.post> | undefined;
      await act(async () => {
        first = api.cards.post(undefined, options);
        await Promise.resolve();
        await api
          .use({ name: "additional-plugin", before: () => undefined })
          .cards.post(undefined, options);
      });
      expect(rendered.container.textContent).toBe("1");
      expect(callbacks).toBe(1);
      await act(async () => {
        gate.resolve();
        await first;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(rendered.container.textContent).toBe("1");
      expect(requests).toBe(2);
    }
  );

  test("updates the active dynamic route without repeating its params or query", async () => {
    window.history.replaceState(null, "", "/optimistic-board/one?filter=open");
    const gate = Promise.withResolvers<void>();
    const app = new Elysia().post("/cards", async () => {
      await gate.promise;
      return { ok: true };
    });
    globalThis.fetch = (async () =>
      makeNdjsonResponse({ message: "confirmed" })) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/optimistic-board/:boardId");
    route.regex = OPTIMISTIC_BOARD_REGEX;
    const rendered = await renderRouter(route, await loadInitialMatch(route));
    ({ cleanup } = rendered);
    let call: ReturnType<typeof api.cards.post> | undefined;
    await act(async () => {
      call = api.cards.post(undefined, {
        optimistic: (cache) =>
          cache.update("/optimistic-board/:boardId", (loader) => ({
            ...loader,
            message: "optimistic",
          })),
      });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toBe("optimistic");
    await act(async () => {
      gate.resolve();
      await call;
    });
    await waitForDom(() => rendered.container.textContent === "confirmed", { timeoutMs: 2000 });
  });

  test("uses the active static route's query snapshot and ignores absent routes", async () => {
    window.history.replaceState(null, "", "/board?filter=open");
    const gate = Promise.withResolvers<void>();
    const app = new Elysia().post("/cards", async () => {
      await gate.promise;
      return { ok: true };
    });
    globalThis.fetch = (async () =>
      makeNdjsonResponse({ message: "confirmed" })) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/board");
    const rendered = await renderRouter(route, await loadInitialMatch(route));
    ({ cleanup } = rendered);
    let call: ReturnType<typeof api.cards.post> | undefined;
    await act(async () => {
      call = api.cards.post(undefined, {
        optimistic(cache) {
          cache.update("/board", (loader) => ({ ...loader, message: "optimistic" }));
          cache.update("/other", (loader) => ({ ...loader, message: "wrong route" }));
          cache.update({ path: "/board", search: { filter: "closed" } }, (loader) => ({
            ...loader,
            message: "wrong filtered snapshot",
          }));
        },
      });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toBe("optimistic");
    await act(async () => {
      gate.resolve();
      await call;
    });
    await waitForDom(() => rendered.container.textContent === "confirmed", { timeoutMs: 2000 });
  });

  test("does not double an increment when a notification precedes the mutation response", async () => {
    const browserEvents = new FakeBrowserEvents();
    (globalThis as typeof globalThis & { [key: symbol]: FakeBrowserEvents })[
      BROWSER_EVENTS_RUNTIME_KEY
    ] = browserEvents;
    const responseGate = Promise.withResolvers<void>();
    let saved = false;
    let reads = 0;
    const app = new Elysia().post("/cards", async () => {
      saved = true;
      await responseGate.promise;
      return { ok: true };
    });
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(input.toString(), window.location.origin);
      if (url.pathname.endsWith("/changes")) {
        return Promise.resolve(
          Response.json({
            changes: saved ? [{ cursor: "1", invalidations: ["/board"] }] : [],
            cursor: saved ? "1" : "0",
            hasMore: false,
            reset: false,
          })
        );
      }
      reads += 1;
      return Promise.resolve(makeNdjsonResponse({ message: saved ? "1" : "0" }));
    }) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/board");
    const rendered = await renderRouter(route, await loadInitialMatch(route), { message: "0" });
    ({ cleanup } = rendered);
    const observed: string[] = [];
    const observer = new MutationObserver(() =>
      observed.push(rendered.container.textContent ?? "")
    );
    observer.observe(rendered.container, { childList: true, subtree: true, characterData: true });
    let call: ReturnType<typeof api.cards.post> | undefined;
    try {
      await act(async () => {
        browserEvents.emit("0");
        await Promise.resolve();
      });
      await act(async () => {
        call = api.cards.post(undefined, {
          optimistic: (cache) =>
            cache.update("/board", (loader) => ({
              ...loader,
              message: String(Number(loader.message) + 1),
            })),
        });
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      await act(async () => {
        browserEvents.emit("1");
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(saved).toBe(true);
      expect(reads).toBe(0);
      expect(rendered.container.textContent).toBe("1");
      await act(async () => {
        responseGate.resolve();
        await call;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(reads).toBeGreaterThan(0);
      expect(rendered.container.textContent).toBe("1");
      expect(observed).not.toContain("2");
      expect(observed).not.toContain("0");
    } finally {
      observer.disconnect();
      responseGate.resolve();
      Reflect.deleteProperty(globalThis, BROWSER_EVENTS_RUNTIME_KEY);
    }
  });

  test("registers one optimistic contribution through all retry attempts", async () => {
    const gate = Promise.withResolvers<void>();
    let attempts = 0;
    const keys: string[] = [];
    const app = new Elysia().post("/cards", async ({ headers }) => {
      attempts += 1;
      keys.push(headers["idempotency-key"] ?? "");
      if (attempts < 3) {
        return Response.json(
          { code: "FURIN_MUTATION_IN_PROGRESS" },
          { status: 409, headers: { "Retry-After": "0" } }
        );
      }
      await gate.promise;
      return { ok: true };
    });
    globalThis.fetch = (async () =>
      makeNdjsonResponse({ message: "1" })) as unknown as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      }),
      { retry: 2 }
    );
    const route = makeRoute("/board");
    const rendered = await renderRouter(route, await loadInitialMatch(route), { message: "0" });
    ({ cleanup } = rendered);
    let callbacks = 0;
    let call: ReturnType<typeof api.cards.post> | undefined;
    await act(async () => {
      call = api.cards.post(undefined, {
        optimistic(cache) {
          callbacks += 1;
          cache.update("/board", (loader) => ({
            ...loader,
            message: String(Number(loader.message) + 1),
          }));
        },
      });
      await waitForDom(() => attempts === 3, { timeoutMs: 2000 });
    });
    expect(attempts).toBe(3);
    expect(callbacks).toBe(1);
    expect(new Set(keys).size).toBe(1);
    expect(rendered.container.textContent).toBe("1");
    await act(async () => {
      gate.resolve();
      await call;
    });
    expect(rendered.container.textContent).toBe("1");
  });
  test("a newer navigation cancels an optimistic wait and stays available", async () => {
    const gate = Promise.withResolvers<void>();
    const app = new Elysia().post("/cards", async () => {
      await gate.promise;
      return { ok: true };
    });
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const path = new URL(input.toString(), window.location.origin).searchParams.get("path");
      return Promise.resolve(
        makeNdjsonResponse({ message: path === "/other" ? "other" : "confirmed" })
      );
    }) as typeof fetch;
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    let navigate: ReturnType<typeof useRouter>["navigate"] | undefined;
    function NavigablePage(props: PageProps) {
      ({ navigate } = useRouter());
      return Page(props);
    }
    const route = makeRoute("/board");
    const initialMatch = await loadInitialMatch(route);
    initialMatch.component = NavigablePage;
    const rendered = await renderRouter(route, initialMatch, undefined, [
      route,
      makeRoute("/other"),
    ]);
    ({ cleanup } = rendered);
    let call: ReturnType<typeof api.cards.post> | undefined;
    await act(async () => {
      call = api.cards.post(undefined, {
        optimistic: (cache) =>
          cache.update("/board", (loader) => ({ ...loader, message: "optimistic" })),
      });
      await Promise.resolve();
    });
    expect(rendered.container.textContent).toBe("optimistic");
    await act(async () => {
      if (!navigate) {
        throw new Error("Router navigation was not registered");
      }
      const replacedNavigation = navigate("/board");
      await Promise.all([replacedNavigation, navigate("/other")]);
    });
    expect(rendered.container.textContent).toBe("other");
    await act(async () => {
      gate.resolve();
      await call;
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(rendered.container.textContent).toBe("other");
    await act(async () => {
      await navigate?.("/board");
    });
    expect(rendered.container.textContent).toBe("confirmed");
  });

  test.each([false, true])(
    "mutation reconciliation waits for a pending user navigation (failure: %s)",
    async (failedNavigation) => {
      const mutationGate = Promise.withResolvers<void>();
      const navigationGate = Promise.withResolvers<Response>();
      const navigationStarted = Promise.withResolvers<void>();
      const paths: Array<string | null> = [];
      const app = new Elysia().post("/cards", async () => {
        await mutationGate.promise;
        return { ok: true };
      });
      globalThis.fetch = ((input: RequestInfo | URL) => {
        const path = new URL(input.toString(), window.location.origin).searchParams.get("path");
        paths.push(path);
        if (path === "/other" && paths.length === 1) {
          navigationStarted.resolve();
          return navigationGate.promise;
        }
        return Promise.resolve(
          makeNdjsonResponse({ message: path === "/other" ? "other" : "confirmed" })
        );
      }) as typeof fetch;
      const api = withSync(
        treaty<typeof app>(window.location.origin, {
          fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
        })
      );
      let navigate: ReturnType<typeof useRouter>["navigate"] | undefined;
      function NavigablePage(props: PageProps) {
        ({ navigate } = useRouter());
        return Page(props);
      }
      const route = makeRoute("/board");
      const initialMatch = await loadInitialMatch(route);
      initialMatch.component = NavigablePage;
      const rendered = await renderRouter(route, initialMatch, undefined, [
        route,
        makeRoute("/other"),
      ]);
      ({ cleanup } = rendered);
      let call: ReturnType<typeof api.cards.post> | undefined;
      let navigation: Promise<void> | undefined;
      await act(async () => {
        call = api.cards.post(undefined, {
          optimistic: (cache) =>
            cache.update("/board", (loader) => ({ ...loader, message: "optimistic" })),
        });
        await Promise.resolve();
        navigation = navigate?.("/other").catch(() => undefined);
        await navigationStarted.promise;
      });
      await act(async () => {
        mutationGate.resolve();
        await call;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      expect(paths).toEqual(["/other"]);
      await act(async () => {
        if (failedNavigation) {
          navigationGate.reject(new TypeError("navigation unavailable"));
        } else {
          navigationGate.resolve(makeNdjsonResponse({ message: "other" }));
        }
        await navigation;
        await new Promise((resolve) => setTimeout(resolve, 5));
      });
      // Transport failures use the router's existing full-page fallback to the requested URL.
      expect(rendered.container.textContent).toBe("other");
      expect(window.location.pathname).toBe("/other");
      expect(paths).toEqual(["/other", "/other"]);
    }
  );

  test("projects only the active Furin instance when its API lives outside the page base path", async () => {
    window.history.replaceState(null, "", "/one/board");
    const gate = Promise.withResolvers<void>();
    const app = new Elysia().post("/api/cards", async () => {
      await gate.promise;
      return Response.json({ message: "rejected" }, { status: 422 });
    });
    const api = withSync(
      treaty<typeof app>(window.location.origin, {
        fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
      })
    );
    const route = makeRoute("/board");
    const first = await renderRouter(
      route,
      await loadInitialMatch(route),
      { message: "one" },
      undefined,
      "/one"
    );
    const second = await renderRouter(
      route,
      await loadInitialMatch(route),
      { message: "two" },
      undefined,
      "/two"
    );
    cleanup = () => {
      second.cleanup();
      first.cleanup();
    };
    let call: ReturnType<typeof api.api.cards.post> | undefined;
    await act(async () => {
      call = api.api.cards.post(undefined, {
        optimistic: (cache) =>
          cache.update("/board", (loader) => ({ ...loader, message: "optimistic one" })),
      });
      await Promise.resolve();
    });
    expect(first.container.textContent).toBe("optimistic one");
    expect(second.container.textContent).toBe("two");
    await act(async () => {
      gate.resolve();
      await call;
    });
    expect(first.container.textContent).toBe("one");
    expect(second.container.textContent).toBe("two");
  });
});
