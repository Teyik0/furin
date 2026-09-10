import { expect, test } from "bun:test";

const CORE_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

const CACHE_HEADER_SCENARIOS = String.raw`
import { join } from "node:path";
import { Elysia } from "elysia";
import { __resetCacheState } from "./src/server/cache/index.ts";
import { scanPages } from "./src/server/router/discovery.ts";
import { createRoutePlugin } from "./src/server/router/plugin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";

const fixturesDir = join(process.cwd(), "tests/fixtures/pages/default");
const etagPattern = /^"testbuild:\d+"$/;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message + ": expected " + String(expected) + ", got " + String(actual));
  }
}

async function getRoute(pattern) {
  const result = await scanPages(fixturesDir);
  const route = result.routes.find((candidate) => candidate.pattern === pattern);
  if (!route) {
    throw new Error("Route " + pattern + " not found in fixtures");
  }
  return { root: result.root, route };
}

async function routeResponse(pattern, buildId) {
  __resetCacheState();
  const { root, route } = await getRoute(pattern);
  const app = new Elysia().use(createRoutePlugin(route, root, buildId));
  return app.handle(new Request("http://localhost" + pattern));
}

__setDevMode(false);

let response = await routeResponse("/isr-page", undefined);
assertEqual(response.status, 200, "ISR response should return 200");
let cacheControl = response.headers.get("cache-control") ?? "";
for (const directive of ["must-revalidate", "max-age=0", "public", "s-maxage=", "stale-while-revalidate"]) {
  assert(cacheControl.includes(directive), "ISR Cache-Control should include " + directive);
}
assert(
  cacheControl.includes("stale-while-revalidate=60"),
  "ISR Cache-Control should use the route revalidate value"
);
assertEqual(response.headers.get("cache-tag"), "/isr-page", "ISR cache-tag should match path");

{
  __resetCacheState();
  const { root, route } = await getRoute("/isr-page");
  route.page.revalidate = 17;
  const app = new Elysia().use(createRoutePlugin(route, root, undefined));
  const configured = await app.handle(new Request("http://localhost/isr-page"));
  assert(
    (configured.headers.get("cache-control") ?? "").includes("stale-while-revalidate=17"),
    "ISR Cache-Control should preserve a non-default route revalidate value"
  );
}

response = await routeResponse("/isr-page", "testbuild");
const etag = response.headers.get("etag");
assert(etag !== null, "ISR response should include ETag when buildId is set");
assert(etagPattern.test(etag), "ISR ETag should match testbuild timestamp format");

response = await routeResponse("/isr-page", "");
assert(response.headers.get("etag") === null, "ISR response should omit ETag when buildId is empty");

{
  __resetCacheState();
  const { root, route } = await getRoute("/isr-page");
  const app = new Elysia().use(createRoutePlugin(route, root, "testbuild"));
  const first = await app.handle(new Request("http://localhost/isr-page"));
  const firstEtag = first.headers.get("etag");
  assert(firstEtag !== null, "first ISR response should include ETag");
  const second = await app.handle(
    new Request("http://localhost/isr-page", { headers: { "if-none-match": firstEtag } })
  );
  assertEqual(second.status, 304, "matching If-None-Match should return 304");
}

{
  __resetCacheState();
  const { root, route } = await getRoute("/isr-page");
  const app = new Elysia().use(createRoutePlugin(route, root, "testbuild"));
  const stale = await app.handle(
    new Request("http://localhost/isr-page", { headers: { "if-none-match": '"stale-build:0"' } })
  );
  assertEqual(stale.status, 200, "stale If-None-Match should return 200");
}

response = await routeResponse("/ssg-page", undefined);
assertEqual(response.headers.get("cache-tag"), "/ssg-page", "SSG cache-tag should match path");
cacheControl = response.headers.get("cache-control") ?? "";
for (const directive of ["s-maxage=31536000", "must-revalidate", "public", "max-age=0"]) {
  assert(cacheControl.includes(directive), "SSG Cache-Control should include " + directive);
}

response = await routeResponse("/ssr-page", undefined);
assertEqual(
  response.headers.get("cache-control"),
  "no-store, no-cache, must-revalidate",
  "SSR Cache-Control should be no-store"
);
assert(response.headers.get("cache-tag") === null, "SSR response should omit cache-tag");
assert(response.headers.get("etag") === null, "SSR response should omit etag");

process.exit(0);
`;

test("route cache header scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: ["bun", "-e", CACHE_HEADER_SCENARIOS],
    cwd: import.meta.dir.replace(CORE_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `cache header subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
