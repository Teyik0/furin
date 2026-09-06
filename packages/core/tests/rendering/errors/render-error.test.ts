import { describe, expect, test } from "bun:test";
import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { createElement, type ReactNode } from "react";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { renderSSR, renderToHTML } from "../../../src/server/render/index.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import type { ErrorComponent } from "../../../src/shared/error.ts";
import { evlogSetMock } from "../../setup/evlog-mock";

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

const RootError: ErrorComponent = () =>
  createElement("div", { "data-testid": "root-error" }, "Root error");
const BlogError: ErrorComponent = () =>
  createElement("div", { "data-testid": "blog-error" }, "Blog error");

function createTestRoot(error: ErrorComponent | undefined): RootLayout {
  return {
    error,
    path: "/test-pages",
    route: ROOT_ROUTE,
  };
}

function createTestRoute(options: {
  component: RuntimePage["component"];
  error: ErrorComponent | undefined;
  loader: RuntimePage["loader"] | undefined;
  pattern: string;
}): ResolvedRoute {
  return {
    error: options.error,
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

describe("renderToHTML — error handling", () => {
  test("renders the nearest error component when loader throws an Error", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Error("boom");
      },
      pattern: "/blog",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError)
    );

    expect(rendered.html).toContain("Blog error");
    expect(rendered.html).not.toContain("Root error");
  });

  test("renderSSR returns a 500 Response when loader throws an error", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Error("kaboom");
      },
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError),
      undefined
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Blog error");
  });

  test("falls back to the built-in 500 component when no error.tsx exists", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
      error: undefined,
      loader: () => {
        throw new Error("kaboom");
      },
      pattern: "/with-loader",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );

    expect(rendered.html).toContain("500 — ERROR");
    expect(rendered.html).toContain("An unexpected error occurred.");
  });

  test("renders the built-in 500 component with a string error (no message)", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
      error: undefined,
      loader: () => {
        // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw for coverage
        throw "plain string boom";
      },
      pattern: "/with-loader",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );

    expect(rendered.html).toContain("500 — ERROR");
    expect(rendered.html).toContain("An unexpected error occurred.");
  });

  test("renderSSR returns 500 with nearest error.tsx when shell render throws", async () => {
    const routeWithShellError = createTestRoute({
      component: () => {
        throw new Error("shell-boom");
      },
      error: BlogError,
      loader: undefined,
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithShellError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError),
      undefined
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Blog error");
  });

  test("renderSSR falls back to built-in 500 when shell render throws and no error.tsx exists", async () => {
    const routeWithShellError = createTestRoute({
      component: () => {
        throw new Error("shell-boom");
      },
      error: undefined,
      loader: undefined,
      pattern: "/with-loader",
    });

    const response = await renderSSR(
      routeWithShellError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined),
      undefined
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("500 — ERROR");
    expect(body).toContain("An unexpected error occurred.");
  });

  test("renderSSR falls back to built-in 500 when user's error.tsx itself throws during shell recovery", async () => {
    const routeWithDoubleFailure = createTestRoute({
      component: () => {
        throw new Error("primary-boom");
      },
      error: () => {
        throw new Error("error-tsx-boom");
      },
      loader: undefined,
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithDoubleFailure,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError),
      undefined
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("500 — ERROR");
    // Default error component shows a generic message instead of the raw error.
    expect(body).toContain("An unexpected error occurred.");
  });

  // ── thrown Response → error.tsx ─────────────────────────────────────────────
  test("renderSSR returns the Response status when loader throws a non-redirect Response", async () => {
    const routeWithUnauthorized = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Response("Login required", { status: 401 });
      },
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithUnauthorized,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError),
      undefined
    );

    // Must be 401, NOT 500 (the previous bug treated this as a redirect →
    // location-less 302 fallback) AND not the legacy "always 500 on error"
    // behaviour. The thrown Response.status is the source of truth.
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("Blog error"); // segment-level error.tsx renders
  });

  test("error.tsx receives the thrown Response.status via error.status prop", async () => {
    const ErrorWithStatus = ({
      error,
    }: {
      error: { message: string; digest: string; status: number };
    }) =>
      createElement(
        "div",
        { "data-testid": "error-with-status" },
        createElement("span", null, `status=${error.status}`),
        createElement("span", null, `msg=${error.message}`)
      );

    const routeWithForbidden = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: ErrorWithStatus,
      loader: () => {
        throw new Response("nope", { status: 403 });
      },
      pattern: "/blog",
    });

    const rendered = await renderToHTML(
      routeWithForbidden,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError)
    );

    // The user error.tsx received status=403 — the Response status, not a
    // hard-coded 500.
    expect(rendered.html).toContain("status=403");
    // The Response body is exposed as the public message.
    expect(rendered.html).toContain("msg=nope");
  });

  test("plain Error throws still surface error.status === 500 by default (regression)", async () => {
    const ErrorWithStatus = ({
      error,
    }: {
      error: { message: string; digest: string; status: number };
    }) =>
      createElement(
        "div",
        { "data-testid": "error-with-status" },
        createElement("span", null, `status=${error.status}`)
      );

    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: ErrorWithStatus,
      loader: () => {
        throw new Error("boom");
      },
      pattern: "/blog",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError)
    );

    expect(rendered.html).toContain("status=500");
  });

  test("renders the built-in 500 component with no message for non-Error, non-string throws", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
      error: undefined,
      loader: () => {
        // biome-ignore lint/style/useThrowOnlyError: intentional non-Error throw for coverage
        throw { secret: "leaked-payload" };
      },
      pattern: "/with-loader",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );

    expect(rendered.html).toContain("500 — ERROR");
    // The thrown object's contents must NOT be surfaced to the client.
    // buildErrorElement passes a generic public message to the default
    // component instead of the raw payload.
    expect(rendered.html).not.toContain("leaked-payload");
    expect(rendered.html).not.toContain("[object Object]");
    expect(rendered.html).toContain("An unexpected error occurred.");
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
  test("default error component renders a 10-hex-char digest", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
      error: undefined,
      loader: () => {
        throw new Error("boom");
      },
      pattern: "/with-loader",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );

    expect(rendered.html).toMatch(DIGEST_RE);
  });

  test("user-defined error component receives a digest prop", async () => {
    const CustomError = ({ error }: { error: { message: string; digest: string } }) =>
      createElement(
        "div",
        { "data-testid": "custom-error" },
        createElement("span", null, `msg=${error.message}`),
        createElement("span", null, `digest=${error.digest}`)
      );

    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: CustomError,
      loader: () => {
        throw new Error("boom");
      },
      pattern: "/blog",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError)
    );

    expect(rendered.html).toMatch(CUSTOM_ERROR_DIGEST_RE);
  });

  test("identical errors produce identical digests across renders", async () => {
    const fixedErr = new Error("stable");
    fixedErr.stack = "Error: stable\n  at frozen (/frozen:1:1)";
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
      error: undefined,
      loader: () => {
        throw fixedErr;
      },
      pattern: "/with-loader",
    });

    const a = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );
    const b = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/with-loader" }),
      createTestRoot(undefined)
    );
    const digestA = a.html.match(DIGEST_RE)?.[0];
    const digestB = b.html.match(DIGEST_RE)?.[0];
    expect(digestA).toBeDefined();
    expect(digestA).toBe(digestB);
  });
});

describe("renderSSR — digest", () => {
  test("__FURIN_DATA__ blob contains a digest under __furinError on 500 response", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Error("kaboom");
      },
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError),
      undefined
    );
    const body = await response.text();
    expect(body).toContain("__furinError");
    expect(body).toMatch(FURIN_ERROR_DIGEST_RE);
  });

  test("server logs the digest alongside the rendered error", async () => {
    evlogSetMock.mockClear();
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Error("log-me");
      },
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot(RootError),
      undefined
    );
    await response.text(); // drain

    const hasDigestLog = evlogSetMock.mock.calls.some(([entry]) => {
      const furin = entry.furin as { [key: string]: unknown } | undefined;
      return typeof furin?.digest === "string" && DIGEST_RE.test(furin.digest as string);
    });
    expect(hasDigestLog).toBe(true);
  });
});
