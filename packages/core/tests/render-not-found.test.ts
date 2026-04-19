import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "elysia";

// Render pipeline uses useLogger() under the hood; stub as in render.test.ts.
mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import type { HTTPHeaders } from "elysia/types";
import { notFound } from "../src/not-found";
import { renderSSR, renderToHTML } from "../src/render";
import { type ResolvedRoute, scanPages } from "../src/router";
import { __setDevMode, IS_DEV } from "../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages-not-found-nested");

function createMockLoaderContext(overrides: Partial<Context> = {}) {
  return {
    params: {},
    query: {},
    request: new Request("http://localhost/test"),
    headers: {},
    cookie: {},
    redirect: (url: string) => new Response(null, { status: 302, headers: { Location: url } }),
    set: { headers: {} as HTTPHeaders },
    path: "/test",
    ...overrides,
  } as Context;
}

describe("renderToHTML — not-found handling", () => {
  const originalDevMode = IS_DEV;
  beforeAll(() => __setDevMode(false));
  afterAll(() => __setDevMode(originalDevMode));

  test("renders the nearest not-found component when loader throws notFound()", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const routeWithNotFound = {
      ...blogRoute,
      page: {
        ...blogRoute.page,
        loader: () => notFound(),
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithNotFound,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );

    expect(rendered.html).toContain("Blog 404");
    expect(rendered.html).not.toContain("Root 404");
  });

  test("renderSSR returns a 404 Response when loader throws notFound()", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const routeWithNotFound = {
      ...blogRoute,
      page: {
        ...blogRoute.page,
        loader: () => notFound(),
      },
    } as ResolvedRoute;

    const response = await renderSSR(
      routeWithNotFound,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Blog 404");
  });

  test("falls back to the built-in 404 component when no not-found.tsx exists", async () => {
    const BARE_FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages");
    const result = await scanPages(BARE_FIXTURES_DIR);
    const loaderRoute = result.routes.find((r) => r.pattern === "/with-loader");
    if (!loaderRoute) {
      throw new Error("Expected /with-loader route in fixture");
    }

    const routeWithNotFound = {
      ...loaderRoute,
      page: {
        ...loaderRoute.page,
        loader: () => notFound(),
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithNotFound,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(rendered.html).toContain("404 — Not Found");
  });
});
