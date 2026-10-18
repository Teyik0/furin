import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
// The fixture root is typed through the package entry, so its page must be too.
import { defineRoute } from "@teyik0/furin";
import { createElement } from "react";
import { __resetCacheState } from "../../../src/server/cache/index.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { route as fixtureRoot } from "../../fixtures/pages/default/root.tsx";
import { mountProductionApp, mountProductionPages } from "../../support/production-app.ts";

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");
const etagPattern = /^"testbuild:\d+"$/;
const originalDevMode = IS_DEV;

beforeEach(() => {
  __setDevMode(false);
  __resetCacheState();
});

afterEach(() => {
  __resetCacheState();
  __resetCompileContext();
  __setDevMode(originalDevMode);
});

async function routeResponse(path: string, buildId: string): Promise<Response> {
  const { app } = await mountProductionPages(fixturesDir, buildId);
  return app.handle(new Request(`http://localhost${path}`));
}

test("ISR responses are publicly cacheable with the route revalidate window", async () => {
  const response = await routeResponse("/isr-page", "");
  expect(response.status).toBe(200);
  const cacheControl = response.headers.get("cache-control") ?? "";
  for (const directive of ["max-age=0", "public", "s-maxage=", "stale-while-revalidate"]) {
    expect(cacheControl).toContain(directive);
  }
  expect(cacheControl).toContain("stale-while-revalidate=60");
  expect(response.headers.get("cache-tag")).toBe("/isr-page");
});

test("ISR Cache-Control preserves a non-default route revalidate value", async () => {
  const { app } = await mountProductionApp({
    buildId: "",
    pages: [
      {
        pattern: "/isr-page",
        route: defineRoute()
          .config({ layout: fixtureRoot, mode: "isr", revalidate: 17 })
          .loader(() => ({ timestamp: Date.now() }))
          .page(({ timestamp }) =>
            createElement("div", { "data-timestamp": String(timestamp) }, "ISR Page")
          ),
      },
    ],
    root: fixtureRoot,
  });
  const configured = await app.handle(new Request("http://localhost/isr-page"));
  const cacheControl = configured.headers.get("cache-control") ?? "";
  expect(cacheControl).toContain("stale-while-revalidate=17");
  expect(cacheControl).toContain("s-maxage=17");
});

test("ISR ETags follow the build ID", async () => {
  const response = await routeResponse("/isr-page", "testbuild");
  const etag = response.headers.get("etag");
  expect(etag).not.toBeNull();
  expect(etag ?? "").toMatch(etagPattern);

  const withoutBuild = await routeResponse("/isr-page", "");
  expect(withoutBuild.headers.get("etag")).toBeNull();
});

test("ISR revalidates conditional requests against the current ETag", async () => {
  const { app } = await mountProductionPages(fixturesDir, "testbuild");
  const first = await app.handle(new Request("http://localhost/isr-page"));
  const firstEtag = first.headers.get("etag");
  expect(firstEtag).not.toBeNull();
  const second = await app.handle(
    new Request("http://localhost/isr-page", { headers: { "if-none-match": firstEtag ?? "" } })
  );
  expect(second.status).toBe(304);

  const stale = await app.handle(
    new Request("http://localhost/isr-page", { headers: { "if-none-match": '"stale-build:0"' } })
  );
  expect(stale.status).toBe(200);
});

test("SSG responses are cached by the CDN for a year and tagged by path", async () => {
  const response = await routeResponse("/ssg-page", "");
  expect(response.headers.get("cache-tag")).toBe("/ssg-page");
  const cacheControl = response.headers.get("cache-control") ?? "";
  for (const directive of ["s-maxage=31536000", "must-revalidate", "public", "max-age=0"]) {
    expect(cacheControl).toContain(directive);
  }
});

test("SSR responses are never cached", async () => {
  const response = await routeResponse("/ssr-page", "");
  expect(response.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
  expect(response.headers.get("cache-tag")).toBeNull();
  expect(response.headers.get("etag")).toBeNull();
});
