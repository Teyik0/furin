/// <reference lib="dom" />
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { toCrossJSON } from "seroval";
import { Link, RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute } from "../../../src/client/router/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const originalFetch = globalThis.fetch;
const HOME_RE = /^\/$/;
const TARGET_RE = /^\/target$/;

function pageModule(component: () => React.ReactElement) {
  return { default: { _route: { __type: "FURIN_ROUTE" } as never, component } };
}

beforeEach(() => {
  installDom();
  resetDomState();
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(toCrossJSON({})), {
        headers: { "Content-Type": "application/x-ndjson" },
      })
    )
  ) as unknown as typeof fetch;
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  await uninstallDom();
});

// The route's load() is the chunk import(): Bun's `modulePreload` (on by
// default for browser builds) inserts a <link rel="modulepreload"> for every
// chunk the target statically imports before the import runs.
test("hovering a Link loads the target route's chunks once", async () => {
  const homeComponent = () => createElement(Link, { preloadDelay: 0, to: "/target" }, "Target");
  const loadTarget = mock(() => Promise.resolve(pageModule(() => createElement("p", null, "T"))));
  const routes: ClientRoute[] = [
    { load: () => Promise.resolve(pageModule(homeComponent)), pattern: "/", regex: HOME_RE },
    { load: loadTarget, pattern: "/target", regex: TARGET_RE },
  ];
  window.history.replaceState(null, "", "/");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(() => {
    root.render(
      createElement(RouterProvider, {
        autoRefresh: false,
        basePath: "",
        defaultPreload: "intent",
        defaultPreloadDelay: 50,
        defaultPreloadStaleTime: 30_000,
        initialData: {},
        initialDigest: undefined,
        initialMatch: {
          ...routes[0],
          component: homeComponent,
          pageRoute: pageModule(homeComponent).default._route,
        },
        initialNotFound: undefined,
        prefetchCacheSize: 50,
        root: null,
        routes,
      } as never)
    );
  });
  const anchor = container.querySelector("a") as HTMLAnchorElement;

  await act(async () => {
    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  await act(async () => {
    anchor.dispatchEvent(
      new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body })
    );
    anchor.dispatchEvent(
      new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  expect(loadTarget).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
  container.remove();
});
