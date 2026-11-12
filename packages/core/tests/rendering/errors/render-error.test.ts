import { afterAll, describe, expect, test } from "bun:test";
import { createElement } from "react";
import { runInSyntheticRenderScope } from "../../../src/server/context-logger.ts";
import { setFurinEvlogOptions } from "../../../src/server/evlog.ts";
import { createInstance, withInstance } from "../../../src/server/instance.ts";
import { renderSSR, renderToHTML } from "../../../src/server/render/index.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import type { ErrorComponent } from "../../../src/shared/error.ts";
import { captureEvlogEvents } from "../../support/evlog-capture.ts";
import { createMockLoaderContext } from "../../support/loader-context.ts";
import { createTestRoot, createTestRoute } from "./test-routes.ts";

const originalDevMode = IS_DEV;
afterAll(() => __setDevMode(originalDevMode));

const RootError: ErrorComponent = () =>
  createElement("div", { "data-testid": "root-error" }, "Root error");
const BlogError: ErrorComponent = () =>
  createElement("div", { "data-testid": "blog-error" }, "Blog error");

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
      createTestRoot({ error: RootError })
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
      createTestRoot({ error: RootError }),
      undefined
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Blog error");
  });

  test.each<[string, unknown, string]>([
    ["an Error", new Error("kaboom"), "kaboom"],
    ["a string", "plain string boom", "plain string boom"],
    ["a non-Error object", { secret: "leaked-payload" }, "leaked-payload"],
  ])(
    "falls back to the built-in 500 component with a digest and no leaked payload when the loader throws %s without error.tsx",
    async (_kind, thrown, payload) => {
      const routeWithError = createTestRoute({
        component: () => createElement("div", { "data-testid": "with-loader" }, "With loader"),
        error: undefined,
        loader: () => {
          throw thrown;
        },
        pattern: "/with-loader",
      });

      const rendered = await renderToHTML(
        routeWithError,
        createMockLoaderContext({ path: "/with-loader" }),
        createTestRoot({})
      );

      expect(rendered.html).toContain("500 — ERROR");
      // buildErrorElement passes a generic public message to the default
      // component instead of the raw thrown value.
      expect(rendered.html).toContain("An unexpected error occurred.");
      expect(rendered.html).not.toContain(payload);
      expect(rendered.html).not.toContain("[object Object]");
      expect(rendered.html).toMatch(DIGEST_RE);
    }
  );

  // A shell failure cannot be attributed to a segment, so it renders the root
  // error.tsx in the minimal document — the same tree the client hydrates.
  test("renderSSR returns 500 with the root error.tsx when shell render throws", async () => {
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
      createTestRoot({ error: RootError }),
      undefined
    );

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("Root error");
    expect(body).not.toContain("Blog error");
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
      createTestRoot({}),
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
      error: undefined,
      loader: undefined,
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithDoubleFailure,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot({
        error: () => {
          throw new Error("error-tsx-boom");
        },
      }),
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
      createTestRoot({ error: RootError }),
      undefined
    );

    // Must be 401, NOT 500 (the previous bug treated this as a redirect →
    // location-less 302 fallback) AND not the legacy "always 500 on error"
    // behaviour. The thrown Response.status is the source of truth.
    expect(response.status).toBe(401);
    const body = await response.text();
    expect(body).toContain("Blog error"); // segment-level error.tsx renders
  });

  test.each<[string, unknown, string[]]>([
    [
      "the thrown Response status and body",
      new Response("nope", { status: 403 }),
      ["status=403", "msg=nope"],
    ],
    ["status 500 for a plain Error (regression)", new Error("boom"), ["status=500"]],
  ])("error.tsx receives %s via error props", async (_case, thrown, expected) => {
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

    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: ErrorWithStatus,
      loader: () => {
        throw thrown;
      },
      pattern: "/blog",
    });

    const rendered = await renderToHTML(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot({ error: RootError })
    );

    for (const text of expected) {
      expect(rendered.html).toContain(text);
    }
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
      createTestRoot({ error: RootError })
    );

    expect(rendered.html).toMatch(CUSTOM_ERROR_DIGEST_RE);
  });
});

describe("renderSSR — digest", () => {
  test("__FURIN_DATA__ blob carries the digest in the failed route match on 500 response", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Error("kaboom");
      },
      pattern: "/blog",
    });

    const response = await runInSyntheticRenderScope(
      () =>
        renderSSR(
          routeWithError,
          createMockLoaderContext({ path: "/blog" }),
          createTestRoot({ error: RootError }),
          undefined
        ),
      { route: "/blog" }
    );
    const body = await response.text();
    expect(body).toContain("__furinMatches");
    expect(body).toMatch(FURIN_ERROR_DIGEST_RE);
    expect(body).toContain('"message":"Something went wrong"');
  });

  test("__FURIN_DATA__ preserves an explicitly empty public error message", async () => {
    const routeWithError = createTestRoute({
      component: () => createElement("div", null, "Blog"),
      error: BlogError,
      loader: undefined,
      pattern: "/blog",
    });

    const response = await renderSSR(
      routeWithError,
      createMockLoaderContext({ path: "/blog" }),
      createTestRoot({ error: RootError }),
      {
        error: new Error("private"),
        headers: {},
        message: "",
        status: 500,
        syncData: {
          __furinMatches: [{ fields: {}, status: "success" }],
          params: {},
          path: "/blog",
          query: {},
        },
        type: "error",
      }
    );
    const body = await response.text();

    expect(body).toContain('"message":""');
  });

  test("server logs the digest alongside the rendered error", async () => {
    const capture = captureEvlogEvents();
    const runtime = createInstance("", "/render-error-log");
    setFurinEvlogOptions(runtime, { drain: capture.drain });
    const event = capture.next();
    const routeWithError = createTestRoute({
      component: () => createElement("div", { "data-testid": "blog-index" }, "Blog"),
      error: BlogError,
      loader: () => {
        throw new Error("log-me");
      },
      pattern: "/blog",
    });

    const response = await withInstance(runtime, () =>
      runInSyntheticRenderScope(
        () =>
          renderSSR(
            routeWithError,
            createMockLoaderContext({ path: "/blog" }),
            createTestRoot({ error: RootError }),
            undefined
          ),
        { route: "/blog" }
      )
    );
    await response.text(); // drain

    expect((await event).furin).toMatchObject({ digest: expect.stringMatching(DIGEST_RE) });
  });
});
