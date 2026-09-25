import { expect, test } from "bun:test";

const ROUTER_TESTS_DIR_RE = /[\\/]tests(?:[\\/].*)?$/;

test("createRoutePlugin scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";

await import("./tests/setup/evlog-mock.ts");

const { Elysia } = await import("elysia");
const { scanPages } = await import("./src/server/router/discovery.ts");
const { createRoutePlugin } = await import("./src/server/router/plugin.ts");
const { __setDevMode, IS_DEV } = await import("./src/server/runtime-env.ts");

const fixturesDir = join(import.meta.dir, "tests/fixtures/pages/default");
const originalDevMode = IS_DEV;
__setDevMode(false);

try {
  let result = await scanPages(fixturesDir);
  const ssgRoute = result.routes.find((route) => route.mode === "ssg");
  if (!ssgRoute) {
    throw new Error("No SSG route in fixtures");
  }

  let app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));
  let res = await app.handle(new Request("http://localhost" + ssgRoute.pattern));

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  expect(await res.text()).toContain("<!DOCTYPE html>");

  result = await scanPages(fixturesDir);
  const ssrRoute = result.routes.find((route) => route.mode === "ssr");
  if (!ssrRoute) {
    throw new Error("No SSR route in fixtures");
  }

  app = new Elysia().use(createRoutePlugin(ssrRoute, result.root));
  res = await app.handle(new Request("http://localhost" + ssrRoute.pattern));

  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");

  result = await scanPages(fixturesDir);
  const isrRoute = result.routes.find((route) => route.mode === "isr");
  if (isrRoute) {
    app = new Elysia().use(createRoutePlugin(isrRoute, result.root));
    res = await app.handle(new Request("http://localhost" + isrRoute.pattern));
    expect(res.status).toBe(200);
  }

  result = await scanPages(fixturesDir);
  const paramRoute = result.routes.find((route) => route.pattern.includes(":"));
  if (paramRoute) {
    app = new Elysia().use(createRoutePlugin(paramRoute, result.root));
    expect(app).toBeInstanceOf(Elysia);
  }

  result = await scanPages(fixturesDir);
  let route = result.routes.find((candidate) => candidate.pattern === "/query-default");
  if (!route) {
    throw new Error("No query-default route in fixtures");
  }

  app = new Elysia().use(createRoutePlugin(route, result.root));
  res = await app.handle(new Request("http://localhost/query-default"));
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBeNull();
  expect(await res.text()).toContain('data-city="Paris"');

  result = await scanPages(fixturesDir);
  route = result.routes.find((candidate) => candidate.pattern === "/query-default");
  if (!route) {
    throw new Error("No query-default route in fixtures");
  }

  app = new Elysia().use(createRoutePlugin(route, result.root));
  res = await app.handle(new Request("http://localhost/query-default?city=Paris"));
  expect(res.status).toBe(200);

  app = new Elysia().use(createRoutePlugin(route, result.root));
  res = await app.handle(new Request("http://localhost/query-default?city=Tokyo"));
  expect(res.status).toBe(200);

  result = await scanPages(fixturesDir);
  const routeWithoutQuery = result.routes.find((candidate) => candidate.mode === "ssg");
  if (routeWithoutQuery) {
    app = new Elysia().use(createRoutePlugin(routeWithoutQuery, result.root));
    res = await app.handle(new Request("http://localhost" + routeWithoutQuery.pattern));
    expect(res.status).toBe(200);
  }
} finally {
  __setDevMode(originalDevMode);
}
process.exit(0);
`,
    ],
    cwd: import.meta.dir.replace(ROUTER_TESTS_DIR_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `route plugin subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
