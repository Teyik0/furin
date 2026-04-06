import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import { Elysia } from "elysia";
import { __resetCacheState } from "../../src/render/cache";
import { createRoutePlugin, scanPages } from "../../src/router";
import { __setDevMode, IS_DEV } from "../../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

const ETAG_PATTERN = /^"testbuild:\d+"$/;

let originalDevMode: boolean;

beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});

afterEach(() => {
  __resetCacheState();
});

afterAll(() => {
  __setDevMode(originalDevMode);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getRoute(pattern: string) {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found in fixtures`);
  }
  return { route, root: result.root };
}

// ── Bullet 7: ISR response has correct Cache-Control with must-revalidate ──────

describe("ISR Cache-Control headers", () => {
  test("contains must-revalidate directive", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    expect(res.status).toBe(200);
    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("must-revalidate");
  });

  test("contains max-age=0 directive", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=0");
  });

  test("contains public directive", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
  });

  test("contains s-maxage directive", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("s-maxage=");
  });

  test("contains stale-while-revalidate directive", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("stale-while-revalidate");
  });
});

// ── Bullet 8: ISR response has Cache-Tag header ────────────────────────────────

describe("ISR Cache-Tag header", () => {
  test("cache-tag header is present in ISR response", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    expect(res.headers.get("cache-tag")).toBeTruthy();
  });

  test("cache-tag value matches the resolved path", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    expect(res.headers.get("cache-tag")).toBe("/isr-page");
  });
});

// ── Bullet 9: ISR response has ETag when buildId is set ───────────────────────

describe("ISR ETag header", () => {
  test("etag header is present when buildId is set", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root, "testbuild"));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    expect(res.headers.get("etag")).toBeTruthy();
  });

  test("etag header matches format testbuild:TIMESTAMP", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root, "testbuild"));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    const etag = res.headers.get("etag") ?? "";
    // Format: "testbuild:1234567890" — quoted string
    expect(etag).toMatch(ETAG_PATTERN);
  });

  test("etag header is absent when buildId is empty", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root, ""));

    const res = await app.handle(new Request("http://localhost/isr-page"));

    expect(res.headers.get("etag")).toBeNull();
  });
});

// ── Bullet 10: ISR responds 304 when ETag matches ─────────────────────────────

describe("ISR 304 conditional request", () => {
  test("returns 304 when If-None-Match matches the etag", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root, "testbuild"));

    // First request: get the ETag
    const res1 = await app.handle(new Request("http://localhost/isr-page"));
    expect(res1.status).toBe(200);
    const etag = res1.headers.get("etag");
    expect(etag).toBeTruthy();

    // Second request with If-None-Match
    const res2 = await app.handle(
      new Request("http://localhost/isr-page", {
        headers: { "if-none-match": etag as string },
      })
    );

    expect(res2.status).toBe(304);
  });

  test("returns 200 when If-None-Match does not match", async () => {
    const { route, root } = await getRoute("/isr-page");
    const app = new Elysia().use(createRoutePlugin(route, root, "testbuild"));

    const res = await app.handle(
      new Request("http://localhost/isr-page", {
        headers: { "if-none-match": '"stale-build:0"' },
      })
    );

    expect(res.status).toBe(200);
  });
});

// ── Bullet 11: SSG response has Cache-Tag and immutable-style Cache-Control ────

describe("SSG cache headers", () => {
  test("cache-tag header is present in SSG response", async () => {
    const { route, root } = await getRoute("/ssg-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssg-page"));

    expect(res.headers.get("cache-tag")).toBeTruthy();
  });

  test("cache-tag value matches the resolved path for SSG", async () => {
    const { route, root } = await getRoute("/ssg-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssg-page"));

    expect(res.headers.get("cache-tag")).toBe("/ssg-page");
  });

  test("Cache-Control contains s-maxage=31536000", async () => {
    const { route, root } = await getRoute("/ssg-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssg-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("s-maxage=31536000");
  });

  test("Cache-Control contains must-revalidate", async () => {
    const { route, root } = await getRoute("/ssg-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssg-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("must-revalidate");
  });

  test("Cache-Control contains public directive", async () => {
    const { route, root } = await getRoute("/ssg-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssg-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("public");
  });

  test("Cache-Control contains max-age=0", async () => {
    const { route, root } = await getRoute("/ssg-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssg-page"));

    const cc = res.headers.get("cache-control") ?? "";
    expect(cc).toContain("max-age=0");
  });
});

// ── Bullet 12: SSR response has no-store ──────────────────────────────────────

describe("SSR cache headers", () => {
  test("Cache-Control is no-store, no-cache, must-revalidate", async () => {
    const { route, root } = await getRoute("/ssr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssr-page"));

    expect(res.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
  });

  test("SSR response has no cache-tag header", async () => {
    const { route, root } = await getRoute("/ssr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssr-page"));

    expect(res.headers.get("cache-tag")).toBeNull();
  });

  test("SSR response has no etag header", async () => {
    const { route, root } = await getRoute("/ssr-page");
    const app = new Elysia().use(createRoutePlugin(route, root));

    const res = await app.handle(new Request("http://localhost/ssr-page"));

    expect(res.headers.get("etag")).toBeNull();
  });
});
