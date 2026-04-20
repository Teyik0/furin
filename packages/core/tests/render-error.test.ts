import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import type { Context } from "elysia";
import { createElement } from "react";

const capturedLogs: Record<string, unknown>[] = [];

mock.module("evlog/elysia", () => ({
  useLogger: () => ({
    set: (entry: Record<string, unknown>) => {
      capturedLogs.push(entry);
    },
  }),
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

    expect(rendered.html).toContain("500 — ERROR");
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

    expect(rendered.html).toContain("500 — ERROR");
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
    expect(body).toContain("500 — ERROR");
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
    expect(body).toContain("500 — ERROR");
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
          throw { secret: "leaked-payload" };
        },
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(rendered.html).toContain("500 — ERROR");
    // The thrown object's contents must NOT be surfaced to the client.
    // errorMessageOf() returns "" for non-Error/non-string throws, so the
    // built-in fallback shows its generic copy instead of the payload.
    expect(rendered.html).not.toContain("leaked-payload");
    expect(rendered.html).not.toContain("[object Object]");
    expect(rendered.html).toContain("We encountered an unexpected error");
  });
});

// ── Digest (Phase 2 Slice 2) ─────────────────────────────────────────────────
// A digest is an opaque 10-hex-char hash of (error.message + error.stack), used
// to correlate client-side error displays with server-side logs WITHOUT leaking
// the stack trace to the browser. The server logs the full error + digest, the
// client only ever sees the digest.

const DIGEST_RE = /[0-9a-f]{10}/;
const CUSTOM_ERROR_DIGEST_RE = /digest=[0-9a-f]{10}/;
const FURIN_ERROR_DIGEST_RE = /"digest":"[0-9a-f]{10}"/;

describe("renderToHTML — digest", () => {
  const originalDevMode = IS_DEV;
  beforeAll(() => __setDevMode(false));
  afterAll(() => __setDevMode(originalDevMode));

  test("default error component renders a 10-hex-char digest", async () => {
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
          throw new Error("boom");
        },
      },
    } as ResolvedRoute;

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );

    expect(rendered.html).toMatch(DIGEST_RE);
  });

  test("user-defined error component receives a digest prop", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    if (!blogRoute) {
      throw new Error("Expected /blog route in fixture");
    }

    const CustomError = ({ error }: { error: { message: string; digest: string } }) =>
      createElement(
        "div",
        { "data-testid": "custom-error" },
        createElement("span", null, `msg=${error.message}`),
        createElement("span", null, `digest=${error.digest}`)
      );

    const routeWithError = {
      ...blogRoute,
      error: CustomError,
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

    expect(rendered.html).toMatch(CUSTOM_ERROR_DIGEST_RE);
  });

  test("identical errors produce identical digests across renders", async () => {
    const BARE_FIXTURES_DIR = join(import.meta.dirname, "fixtures", "pages");
    const result = await scanPages(BARE_FIXTURES_DIR);
    const loaderRoute = result.routes.find((r) => r.pattern === "/with-loader");
    if (!loaderRoute) {
      throw new Error("Expected /with-loader route in fixture");
    }

    const fixedErr = new Error("stable");
    fixedErr.stack = "Error: stable\n  at frozen (/frozen:1:1)";
    const routeWithError = {
      ...loaderRoute,
      page: {
        ...loaderRoute.page,
        loader: () => {
          throw fixedErr;
        },
      },
    } as ResolvedRoute;

    const a = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );
    const b = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      result.root
    );
    const digestA = a.html.match(DIGEST_RE)?.[0];
    const digestB = b.html.match(DIGEST_RE)?.[0];
    expect(digestA).toBeDefined();
    expect(digestA).toBe(digestB);
  });
});

describe("renderSSR — digest", () => {
  const originalDevMode = IS_DEV;
  beforeAll(() => __setDevMode(false));
  afterAll(() => __setDevMode(originalDevMode));

  test("__FURIN_DATA__ blob contains a digest under __furinError on 500 response", async () => {
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
    const body = await response.text();
    expect(body).toContain("__furinError");
    expect(body).toMatch(FURIN_ERROR_DIGEST_RE);
  });

  test("server logs the digest alongside the rendered error", async () => {
    capturedLogs.length = 0;
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
          throw new Error("log-me");
        },
      },
    } as ResolvedRoute;

    const response = await renderSSR(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      result.root
    );
    await response.text(); // drain

    const hasDigestLog = capturedLogs.some((entry) => {
      const furin = entry.furin as Record<string, unknown> | undefined;
      return typeof furin?.digest === "string" && DIGEST_RE.test(furin.digest as string);
    });
    expect(hasDigestLog).toBe(true);
  });
});
