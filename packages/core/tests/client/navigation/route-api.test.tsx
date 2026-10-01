import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { toCrossJSON } from "seroval";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { RouterProvider, useRouter } from "../../../src/client/link.tsx";
import type { LoadedClientRoute } from "../../../src/client/router/types.ts";
import { getRouteApi } from "../../../src/client.ts";
import { defineRoute as createRoute, defineRootRoute } from "../../../src/define-route.ts";
import { buildElement } from "../../../src/server/render/element.tsx";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { useDomTests, waitForDom } from "../../support/dom.ts";

declare const defineRoute: typeof import("../../../src/define-route.ts").defineRoute;
declare const t: typeof import("elysia").t;
const layout = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);

const defineBoard = () =>
  defineRoute()
    .config({ layout, mode: "ssr", params: t.Object({ boardId: t.Number() }) })
    .loader(() => ({ title: "Board" }))
    .page(() => null);

declare module "@teyik0/furin/routes" {
  interface RoutePatternMap {
    "/route-api-board/:boardId": ReturnType<typeof defineBoard>;
  }
}

const board = getRouteApi("/route-api-board/:boardId");
const BOARD_PATTERN = /^\/route-api-board\/[^/]+$/;

function Toolbar() {
  const { boardId } = board.useParams();
  const { title } = board.useLoaderData();
  return createElement("output", null, `${boardId}:${title}`);
}

const pageRoute: RuntimeRoute = { __type: "FURIN_ROUTE" };
const route: ResolvedRoute = {
  mode: "ssr",
  page: { __type: "FURIN_PAGE", _route: pageRoute, component: () => createElement(Toolbar) },
  path: "/virtual/board.tsx",
  pattern: "/route-api-board/:boardId",
  routeChain: [pageRoute],
  segmentBoundaries: [],
};

describe("getRouteApi", () => {
  test("reads the active loader and validated params during SSR without fetching", () => {
    const element = buildElement(route, { params: { boardId: 42 }, title: "SSR board" }, pageRoute);

    expect(renderToStaticMarkup(element)).toBe("<output>42:SSR board</output>");
  });

  test("route definitions do not expose a callable that pretends to read loader data", () => {
    const definition = createRoute()
      .config({ layout, mode: "ssr" })
      .loader(() => ({ title: "Board" }))
      .page(() => null);

    expect("useLoaderData" in definition).toBe(false);
  });

  test("rejects a snapshot from a different active route", () => {
    expect(() =>
      renderToStaticMarkup(buildElement({ ...route, pattern: "/other" }, {}, pageRoute))
    ).toThrow('getRouteApi("/route-api-board/:boardId")');
  });

  test("does not expose params, query or path as loader fields", () => {
    function Keys() {
      return createElement("output", null, Object.keys(board.useLoaderData()).sort().join(","));
    }
    const element = buildElement(
      { ...route, page: { ...route.page, component: Keys } },
      {
        __furinQueries: [],
        params: { boardId: 42 },
        path: "/board/42",
        query: { page: 1 },
        title: "Board",
      },
      pageRoute
    );
    expect(renderToStaticMarkup(element)).toBe("<output>title</output>");
  });
});

describe("getRouteApi in the browser", () => {
  useDomTests();

  test("reads hydrated data and follows refreshes and param changes", async () => {
    let router: ReturnType<typeof useRouter> | undefined;
    function Page() {
      router = useRouter();
      return createElement(Toolbar);
    }
    const match: LoadedClientRoute = {
      component: Page,
      load: async () => ({ default: { _route: pageRoute, component: Page } }),
      pageRoute,
      pattern: route.pattern,
      regex: BOARD_PATTERN,
    };
    window.history.replaceState(null, "", "/route-api-board/42");
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (() => {
      requests += 1;
      const data =
        requests === 1
          ? { params: { boardId: 42 }, title: "Refreshed board" }
          : { params: { boardId: 43 }, title: "Other board" };
      return Promise.resolve(
        new Response(`${JSON.stringify(toCrossJSON(data))}\n`, {
          headers: { "Content-Type": "application/x-ndjson" },
        })
      );
    }) as unknown as typeof fetch;

    try {
      await act(() =>
        root.render(
          createElement(RouterProvider, {
            autoRefresh: false,
            basePath: "",
            defaultPreload: false,
            defaultPreloadDelay: 50,
            defaultPreloadStaleTime: 30_000,
            initialData: { params: { boardId: 42 }, title: "Hydrated board" },
            initialDigest: undefined,
            initialMatch: match,
            initialNotFound: undefined,
            prefetchCacheSize: 50,
            root: null,
            routes: [match],
          })
        )
      );
      expect(container.textContent).toBe("42:Hydrated board");
      expect(requests).toBe(0);
      await act(async () => {
        await router?.refresh();
      });
      expect(container.textContent).toBe("42:Refreshed board");
      await act(async () => {
        router?.prefetch({
          to: "/route-api-board/:boardId",
          params: { boardId: 43 },
          staleTime: 5000,
        });
        await waitForDom(() => requests === 2, undefined);
      });
      expect(container.textContent).toBe("42:Refreshed board");
      await act(async () => {
        await router?.navigate({ to: "/route-api-board/:boardId", params: { boardId: 43 } });
      });
      expect(container.textContent).toBe("43:Other board");
      expect(requests).toBe(2);
    } finally {
      await act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  });
});
