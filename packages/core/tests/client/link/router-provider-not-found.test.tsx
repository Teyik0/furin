import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { RouterProvider, type RouterProviderProps } from "../../../src/client/link.tsx";

const PAGE_PATTERN = /^\/page$/;

test.each([false, true])(
  "an unknown URL keeps the root layout with a grouped boundary: %s",
  (grouped) => {
    const root: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      layout: ({ children, path }) => createElement("main", { "data-route-path": path }, children),
    };
    const props: RouterProviderProps = {
      autoRefresh: false,
      basePath: "",
      defaultPreload: "intent",
      defaultPreloadDelay: 50,
      defaultPreloadStaleTime: 30_000,
      initialData: { params: {}, path: "/missing", query: {} },
      initialDigest: undefined,
      initialMatch: null,
      initialNotFound: {},
      prefetchCacheSize: 50,
      root,
      routes: grouped
        ? [
            {
              load: () => Promise.resolve({ default: { _route: root, component: () => null } }),
              pattern: "/page",
              regex: PAGE_PATTERN,
              segmentBoundaries: [
                {
                  depth: 0,
                  isRoot: false,
                  notFound: () => createElement("p", null, "Group 404"),
                },
              ],
            },
          ]
        : [],
    };

    const html = renderToStaticMarkup(createElement(RouterProvider, props));

    expect(html).toContain('<main data-route-path="/missing">');
    expect(html).toContain("404");
    expect(html).not.toContain("Group 404");
  }
);
