import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "elysia";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import type { HTTPHeaders } from "elysia/types";
import { renderSSR, renderToHTML } from "../src/render";
import { type ResolvedRoute, scanPages } from "../src/router";
import { __setDevMode, IS_DEV } from "../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages-error-nested");

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

describe("renderToHTML — error handling", () => {
  const originalDevMode = IS_DEV;
  beforeAll(() => __setDevMode(false));
  afterAll(() => __setDevMode(originalDevMode));

  test("renders the nearest error component when loader throws an Error", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const routeWithError = {
      ...blogRoute,
      page: {
        ...blogRoute.page,
        loader: () => {
          throw new Error("boom");
        },
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );

    expect(rendered.html).toContain("Blog error");
    expect(rendered.html).not.toContain("Root error");
  });

  test("renderSSR returns a 500 Response when loader throws an error", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const routeWithError = {
      ...blogRoute,
      page: {
        ...blogRoute.page,
        loader: () => {
          throw new Error("kaboom");
        },
      },
    } as ResolvedRoute;

    const response = await renderSSR(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Blog error");
  });

  test("falls back to the built-in 500 component when no error.tsx exists", async () => {
    const BARE_FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages");
    const result = await scanPages(BARE_FIXTURES_DIR);
    const loaderRoute = result.routes.find((r) => r.pattern === "/with-loader");
    if (!loaderRoute) {
      throw new Error("Expected /with-loader route in fixture");
    }

    const routeWithError = {
      ...loaderRoute,
      page: {
        ...loaderRoute.page,
        loader: () => {
          throw new Error("kaboom");
        },
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(rendered.html).toContain("500 — Something went wrong");
    expect(rendered.html).toContain("kaboom");
  });

  test("renders the built-in 500 component with a string error (no message)", async () => {
    const BARE_FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages");
    const result = await scanPages(BARE_FIXTURES_DIR);
    const loaderRoute = result.routes.find((r) => r.pattern === "/with-loader");
    if (!loaderRoute) {
      throw new Error("Expected /with-loader route in fixture");
    }

    const routeWithError = {
      ...loaderRoute,
      page: {
        ...loaderRoute.page,
        loader: () => {
          // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw for coverage
          throw "plain string boom";
        },
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(rendered.html).toContain("500 — Something went wrong");
    expect(rendered.html).toContain("plain string boom");
  });

  test("renderSSR returns 500 with nearest error.tsx when shell render throws", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const routeWithShellError = {
      ...blogRoute,
      page: {
        ...blogRoute.page,
        component: () => {
          throw new Error("shell-boom");
        },
      },
    } as ResolvedRoute;

    const response = await renderSSR(
      routeWithShellError,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Blog error");
  });

  test("renderSSR falls back to built-in 500 when shell render throws and no error.tsx exists", async () => {
    const BARE_FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages");
    const result = await scanPages(BARE_FIXTURES_DIR);
    const loaderRoute = result.routes.find((r) => r.pattern === "/with-loader");
    if (!loaderRoute) {
      throw new Error("Expected /with-loader route in fixture");
    }

    const routeWithShellError = {
      ...loaderRoute,
      page: {
        ...loaderRoute.page,
        component: () => {
          throw new Error("shell-boom");
        },
      },
    } as ResolvedRoute;

    const response = await renderSSR(
      routeWithShellError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("500 — Something went wrong");
    expect(body).toContain("shell-boom");
  });

  test("renderSSR falls back to built-in 500 when user's error.tsx itself throws during shell recovery", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const routeWithDoubleFailure = {
      ...blogRoute,
      page: {
        ...blogRoute.page,
        component: () => {
          throw new Error("primary-boom");
        },
      },
      error: () => {
        throw new Error("error-tsx-boom");
      },
    } as ResolvedRoute;

    const response = await renderSSR(
      routeWithDoubleFailure,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("500 — Something went wrong");
    // Default error component rendered the original shell-render error message.
    expect(body).toContain("primary-boom");
  });

  test("renders the built-in 500 component with no message for non-Error, non-string throws", async () => {
    const BARE_FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages");
    const result = await scanPages(BARE_FIXTURES_DIR);
    const loaderRoute = result.routes.find((r) => r.pattern === "/with-loader");
    if (!loaderRoute) {
      throw new Error("Expected /with-loader route in fixture");
    }

    const routeWithError = {
      ...loaderRoute,
      page: {
        ...loaderRoute.page,
        loader: () => {
          // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw for coverage
          throw { notAnError: true };
        },
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(rendered.html).toContain("500 — Something went wrong");
    // No <p> is rendered because errorMessageOf() returned empty string.
    expect(rendered.html).not.toContain("<p>");
  });
});
