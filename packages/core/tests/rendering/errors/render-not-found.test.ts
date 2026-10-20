import { afterAll, describe, expect, test } from "bun:test";
import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { createElement, type ElementType, type ReactNode } from "react";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { defineRootRoute } from "../../../src/define-route.ts";
import { renderRootNotFound, renderSSR, renderToHTML } from "../../../src/server/render/index.ts";
import { runPublicLoaders } from "../../../src/server/render/loaders.ts";
import { adaptDefinedLayout } from "../../../src/server/router/defined-route.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { type NotFoundComponent, notFound } from "../../../src/shared/not-found.ts";
import { findRouteFailure } from "../../../src/shared/route-matches.ts";

const originalDevMode = IS_DEV;
afterAll(() => __setDevMode(originalDevMode));

const FURIN_DATA_SCRIPT_RE =
  /<script id="__FURIN_DATA__" type="application\/json">([\s\S]*?)<\/script>/;
const ROUTE_TEMPLATE_RE = /<template[^>]*id="__FURIN_ROUTE_FRAMES__"[^>]*>([\s\S]*?)<\/template>/;

async function documentData(html: string): Promise<{ [key: string]: unknown }> {
  const json = html.match(FURIN_DATA_SCRIPT_RE)?.[1];
  if (json !== undefined) {
    return JSON.parse(json);
  }
  const template = html.match(ROUTE_TEMPLATE_RE)?.[1];
  if (template === undefined) {
    throw new Error("Document hydration payload missing");
  }
  const body = new Blob([template.replaceAll("&lt;", "<").replaceAll("&amp;", "&")]).stream();
  return (await parseDeferredNdjson(body, undefined)).syncData;
}

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
    page: {
      __type: "FURIN_PAGE",
      _route: ROOT_ROUTE,
      component: options.component,
      ...(options.loader ? { loader: options.loader } : {}),
    },
    path: `/test-pages${options.pattern}/index.tsx`,
    pattern: options.pattern,
    routeChain: [ROOT_ROUTE],
    // The page's own directory boundary, inside the root layout.
    segmentBoundaries: options.notFound
      ? [{ depth: 0, notFound: options.notFound, path: `/test-pages${options.pattern}` }]
      : [],
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
  test("public-only failures skip layouts requiring unexecuted request loaders", async () => {
    let requestCalls = 0;
    let layoutCalls = 0;
    const rootRoute: RuntimeRoute = {
      ...ROOT_ROUTE,
      loader: () => ({ title: "Library" }),
      requestLoader: () => {
        requestCalls += 1;
        return { viewer: "Alice" };
      },
      layout: () => {
        layoutCalls += 1;
        throw new Error("Request data is required");
      },
    };
    const route = createTestRoute({
      component: () => null,
      loader: () => notFound(undefined),
      notFound: BlogNotFound,
      pattern: "/blog",
    });
    route.routeChain = [rootRoute];
    route.page._route = rootRoute;
    const context = createMockLoaderContext({ path: "/blog" });
    const result = await runPublicLoaders(route, context);
    const response = await renderSSR(
      route,
      context,
      { ...createTestRoot(RootNotFound), route: rootRoute },
      result
    );
    expect(response.status).toBe(404);
    // The root segment has no data, so its own not-found renders in the
    // minimal document: the page's boundary sits inside the skipped layout.
    expect(await response.text()).toContain("Root 404");
    expect(layoutCalls).toBe(0);
    expect(requestCalls).toBe(0);
  });

  test("redirects do not wait for pending parent data", async () => {
    const parent = Promise.withResolvers<{ title: string }>();
    const rootRoute: RuntimeRoute = { ...ROOT_ROUTE, loader: () => parent.promise };
    const route = createTestRoute({
      component: () => null,
      loader: () => {
        throw new Response(null, { status: 302, headers: { location: "/login" } });
      },
      notFound: undefined,
      pattern: "/blog",
    });
    route.routeChain = [rootRoute];
    route.page._route = rootRoute;
    try {
      const result = await Promise.race([
        renderSSR(
          route,
          createMockLoaderContext({ path: "/blog" }),
          { ...createTestRoot(RootNotFound), route: rootRoute },
          undefined
        ),
        Bun.sleep(100).then(() => undefined),
      ]);
      expect(result?.status).toBe(302);
      expect(result?.headers.get("location")).toBe("/login");
    } finally {
      parent.resolve({ title: "Library" });
    }
  });

  test.each([404, 503])(
    "keeps a pending successful root and excludes failed intermediate layouts (%s)",
    async (status) => {
      let rootCalls = 0;
      const rootRoute: RuntimeRoute = {
        ...ROOT_ROUTE,
        loader: async () => {
          rootCalls += 1;
          await Bun.sleep(5);
          return { dashboard: { settings: { theme: "forest" } } };
        },
        layout: ({ children, dashboard }) =>
          createElement(
            ROOT_ROUTE.layout as ElementType,
            null,
            createElement(
              "section",
              { "data-theme": (dashboard as { settings: { theme: string } }).settings.theme },
              children
            )
          ),
      };
      const failed: RuntimeRoute = {
        __type: "FURIN_ROUTE",
        parent: rootRoute,
        loader: () => {
          if (status === 404) {
            notFound(undefined);
          }
          throw new Response("Section unavailable", { status });
        },
        layout: () => {
          throw new Error("Failed layout must not run");
        },
      };
      const descendant: RuntimeRoute = {
        __type: "FURIN_ROUTE",
        parent: failed,
        loader: () => ({ secret: "Descendant data must not leak" }),
        layout: () => {
          throw new Error("Descendant layout must not run");
        },
      };
      const route = createTestRoute({
        component: () => null,
        loader: () => ({ pageSecret: "Page data must not leak" }),
        notFound: BlogNotFound,
        pattern: "/blog",
      });
      route.routeChain = [rootRoute, failed, descendant];
      route.page._route = descendant;
      const response = await renderSSR(
        route,
        createMockLoaderContext({ path: "/blog" }),
        { ...createTestRoot(RootNotFound), route: rootRoute },
        undefined
      );
      expect(response.status).toBe(status);
      const html = await response.text();
      expect(html).toContain('data-theme="forest"');
      expect(html).not.toContain("must not leak");
      expect(rootCalls).toBe(1);
      const data = await documentData(html);
      expect(data.secret).toBeUndefined();
      expect(data.pageSecret).toBeUndefined();
    }
  );

  test("an unmatched URL does not invoke a root layout whose loader has not run", async () => {
    let layoutCalls = 0;
    let loaderCalls = 0;
    const rootRoute: RuntimeRoute = {
      ...ROOT_ROUTE,
      layout: () => {
        layoutCalls += 1;
        throw new Error("Root data is required");
      },
      loader: () => {
        loaderCalls += 1;
        return { dashboard: { settings: { theme: "forest" } } };
      },
    };
    const response = await renderRootNotFound(
      { ...createTestRoot(RootNotFound), route: rootRoute },
      new Request("http://localhost/unknown")
    );
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("Root 404");
    expect(layoutCalls).toBe(0);
    expect(loaderCalls).toBe(0);
    expect(findRouteFailure(await documentData(html))?.index).toBe(0);
  });

  test.each([404, 500])(
    "does not invoke the root layout when its loader fails with %s",
    async (status) => {
      let layoutCalls = 0;
      const rootRoute: RuntimeRoute = {
        ...ROOT_ROUTE,
        layout: () => {
          layoutCalls += 1;
          throw new Error("Root layout must not render without its loader data");
        },
        loader: () => {
          if (status === 404) {
            notFound({ data: { resource: "root" }, message: "Root missing" });
          }
          throw new Error("Root unavailable");
        },
      };
      const route = createTestRoute({
        component: () => createElement("p", null, "Resource"),
        loader: () => ({ childOnly: "Must not be exposed" }),
        notFound: BlogNotFound,
        pattern: "/blog",
      });
      route.routeChain = [rootRoute];
      route.page._route = rootRoute;
      const response = await renderSSR(
        route,
        createMockLoaderContext({ path: "/blog" }),
        { ...createTestRoot(RootNotFound), route: rootRoute },
        undefined
      );

      expect(response.status).toBe(status);
      const html = await response.text();
      expect(layoutCalls).toBe(0);
      expect(html).toContain("<!DOCTYPE html>");
      expect(html).not.toContain("Must not be exposed");
      // A root failure renders the root's own boundary, not the page's.
      expect(html).toContain(status === 404 ? "Root 404" : "500 — ERROR");
      expect(html).not.toContain("Blog 404");
    }
  );

  test("preserves required root loader data when a child loader throws notFound", async () => {
    let rootCalls = 0;
    const rootDefinition = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => {
        rootCalls += 1;
        return { dashboard: { settings: { theme: "forest" } } };
      })
      .layout(({ children, dashboard }) =>
        createElement(
          ROOT_ROUTE.layout as ElementType,
          null,
          createElement("section", { "data-theme": dashboard.settings.theme }, children)
        )
      );
    const rootRoute = adaptDefinedLayout(rootDefinition, undefined);
    const route = createTestRoute({
      component: () => createElement("p", null, "Resource"),
      loader: async ({ dashboard }) => {
        expect(await dashboard).toEqual({ settings: { theme: "forest" } });
        notFound({ data: { resource: "missing" }, message: "Resource missing" });
      },
      notFound: BlogNotFound,
      pattern: "/blog",
    });
    route.routeChain = [rootRoute];
    route.page._route = rootRoute;
    const response = await renderSSR(
      route,
      createMockLoaderContext({ path: "/blog" }),
      { ...createTestRoot(RootNotFound), route: rootRoute },
      undefined
    );

    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain('data-theme="forest"');
    expect(html).toContain("Blog 404");
    expect(rootCalls).toBe(1);
    const payload = await documentData(html);
    expect(payload.dashboard).toEqual({ settings: { theme: "forest" } });
    expect(findRouteFailure(payload)?.status).toBe("notFound");
  });

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

  test("renderSSR marks the failed segment as notFound in __FURIN_DATA__ for SPA nav detection", async () => {
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
    // The payload MUST carry the failed match so the client's `classifySpaResponse`
    // can distinguish a loader-thrown notFound() from a generic 5xx.
    const match = body.match(FURIN_DATA_SCRIPT_RE);
    expect(match).not.toBeNull();
    expect(findRouteFailure(JSON.parse(match?.[1] ?? "{}"))).toEqual({
      error: { data: { reason: "deleted" }, message: "missing" },
      index: 1,
      status: "notFound",
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
