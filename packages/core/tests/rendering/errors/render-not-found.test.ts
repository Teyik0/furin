import { describe, expect, test } from "bun:test";
import type { Context } from "elysia";
import { createElement, type ReactNode } from "react";
import "../../setup/evlog-mock";

import type { HTTPHeaders } from "elysia/types";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { renderSSR, renderToHTML } from "../../../src/server/render/index.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { type NotFoundComponent, notFound } from "../../../src/shared/not-found.ts";

const FURIN_DATA_SCRIPT_RE =
  /<script id="__FURIN_DATA__" type="application\/json">([\s\S]*?)<\/script>/;

const ROOT_ROUTE: RuntimeRoute = {
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

const BlogNotFound: NotFoundComponent = () =>
  createElement("div", { "data-testid": "blog-not-found" }, "Blog 404");
const RootNotFound: NotFoundComponent = () =>
  createElement("div", { "data-testid": "root-not-found" }, "Root 404");

function createTestRoot(notFoundComponent: NotFoundComponent | undefined): RootLayout {
  return {
    notFound: notFoundComponent,
    path: "/test-pages",
    route: ROOT_ROUTE,
  };
}

function createTestRoute(options: {
  component: RuntimePage["component"];
  loader: RuntimePage["loader"] | undefined;
  notFound: NotFoundComponent | undefined;
  pattern: string;
}): ResolvedRoute {
  return {
    mode: "ssr",
    notFound: options.notFound,
    page: {
      __type: "FURIN_PAGE",
      _route: ROOT_ROUTE,
      component: options.component,
      ...(options.loader ? { loader: options.loader } : {}),
    },
    path: `/test-pages${options.pattern}/index.tsx`,
    pattern: options.pattern,
    routeChain: [ROOT_ROUTE],
    segmentBoundaries: [],
    tags: [],
  };
}

function createMockLoaderContext(overrides: Partial<Context>) {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/test",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/test"),
    set: { headers: {} as HTTPHeaders },
    ...overrides,
  } as Context;
}

__setDevMode(false);

describe("renderToHTML — not-found handling", () => {
  test("renders the nearest not-found component when loader throws notFound()", async () => {
    const routeWithNotFound = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      loader: () => {
        notFound(undefined);
      },
      notFound: BlogNotFound,
      pattern: "/blog",
    });

    const rendered = await renderToHTML(
      routeWithNotFound,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootNotFound)
    );

    expect(rendered.html).toContain("Blog 404");
    expect(rendered.html).not.toContain("Root 404");
  });

  test("renderSSR returns a 404 Response when loader throws notFound()", async () => {
    const routeWithNotFound = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      loader: () => {
        notFound(undefined);
      },
      notFound: BlogNotFound,
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithNotFound,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootNotFound),
      undefined
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Blog 404");
  });

  test("renderSSR injects __furinStatus=404 into __FURIN_DATA__ for SPA nav detection (Slice 8)", async () => {
    const routeWithNotFound = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      loader: () => {
        notFound({ data: { reason: "deleted" }, message: "missing" });
      },
      notFound: BlogNotFound,
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithNotFound,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootNotFound),
      undefined
    );

    expect(response.status).toBe(404);
    const body = await response.text();
    // The payload MUST carry __furinStatus so the client's `classifySpaResponse`
    // can distinguish a loader-thrown notFound() from a generic 5xx.
    const match = body.match(FURIN_DATA_SCRIPT_RE);
    expect(match).not.toBeNull();
    const payload = JSON.parse(match?.[1] ?? "{}");
    expect(payload.__furinStatus).toBe(404);
    expect(payload.__furinNotFound).toMatchObject({
      data: { reason: "deleted" },
      message: "missing",
    });
  });

  test("falls back to the built-in 404 component when no not-found.tsx exists", async () => {
    const routeWithNotFound = createTestRoute({
      component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
      loader: () => {
        notFound(undefined);
      },
      notFound: undefined,
      pattern: "/with-loader",
    });

    const rendered = await renderToHTML(
      routeWithNotFound,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );

    expect(rendered.html).toContain("404 — NOT FOUND");
  });
});
