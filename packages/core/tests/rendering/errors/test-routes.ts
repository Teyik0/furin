import { createElement, type ReactNode } from "react";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import type {
  ResolvedRoute,
  RootLayout,
  SegmentBoundary,
} from "../../../src/server/router/types.ts";

/** The convention components a test boundary carries. */
type TestBoundary = Pick<SegmentBoundary, "error" | "notFound">;

export const ROOT_ROUTE: RuntimeRoute = {
  __type: "FURIN_ROUTE",
  layout: ({ children }: { children: ReactNode | undefined }) =>
    createElement(
      "html",
      { lang: "en" },
      createElement("head", null, createElement(HeadContent)),
      createElement(
        "body",
        null,
        createElement("div", { "data-testid": "root-layout" }, children),
        createElement(Scripts)
      )
    ),
};

export function createTestRoot(boundary: TestBoundary): RootLayout {
  return {
    ...boundary,
    path: "/test-pages",
    route: ROOT_ROUTE,
  };
}

export function createTestRoute(
  options: TestBoundary & {
    component: RuntimePage["component"];
    loader: RuntimePage["loader"] | undefined;
    pattern: string;
  }
): ResolvedRoute {
  const { component, loader, pattern, ...boundary } = options;
  return {
    mode: "ssr",
    page: {
      __type: "FURIN_PAGE",
      _route: ROOT_ROUTE,
      component,
      ...(loader ? { loader } : {}),
    },
    path: `/test-pages${pattern}/index.tsx`,
    pattern,
    routeChain: [ROOT_ROUTE],
    // The page's own directory boundary, inside the root layout.
    segmentBoundaries:
      boundary.error || boundary.notFound
        ? [{ depth: 0, ...boundary, path: `/test-pages${pattern}` }]
        : [],
    tags: [],
  };
}
