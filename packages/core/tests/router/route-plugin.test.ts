import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import { Elysia } from "elysia";
import { createRoutePlugin, queryDefaultRedirectHook, scanPages } from "../../src/router";
import { __setDevMode, IS_DEV } from "../../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("createRoutePlugin", () => {
  test("SSG route returns HTML with cache headers", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find((r) => r.mode === "ssg");
    if (!ssgRoute) {
      throw new Error("No SSG route in fixtures");
    }

    const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));

    const res = await app.handle(new Request(`http://localhost${ssgRoute.pattern}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
  });

  test("SSR route returns streamed HTML", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssrRoute = result.routes.find((r) => r.mode === "ssr");
    if (!ssrRoute) {
      throw new Error("No SSR route in fixtures — add an SSR fixture to ensure this test runs");
    }

    const app = new Elysia().use(createRoutePlugin(ssrRoute, result.root));

    const res = await app.handle(new Request(`http://localhost${ssrRoute.pattern}`));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  test("ISR route returns HTML", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const isrRoute = result.routes.find((r) => r.mode === "isr");
    if (!isrRoute) {
      return; // skip if no ISR routes in fixtures
    }

    const app = new Elysia().use(createRoutePlugin(isrRoute, result.root));

    const res = await app.handle(new Request(`http://localhost${isrRoute.pattern}`));

    expect(res.status).toBe(200);
  });

  test("route with params schema sets up guard", async () => {
    const result = await scanPages(FIXTURES_DIR);
    // Find a route with dynamic params like /blog/:slug
    const paramRoute = result.routes.find((r) => r.pattern.includes(":"));
    if (!paramRoute) {
      return;
    }

    const app = new Elysia().use(createRoutePlugin(paramRoute, result.root));

    // The plugin should set up correctly (no throw)
    expect(app).toBeInstanceOf(Elysia);
  });
});

describe("query default redirect", () => {
  test("redirects to canonical URL when query defaults are applied", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === "/query-default");
    if (!route) {
      throw new Error("No query-default route in fixtures");
    }

    const app = new Elysia().use(createRoutePlugin(route, result.root));

    const res = await app.handle(new Request("http://localhost/query-default"));

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/query-default?city=Paris");
  });

  test("does NOT redirect when query param is explicitly provided", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === "/query-default");
    if (!route) {
      throw new Error("No query-default route in fixtures");
    }

    const app = new Elysia().use(createRoutePlugin(route, result.root));

    const res = await app.handle(new Request("http://localhost/query-default?city=Paris"));

    expect(res.status).toBe(200);
  });

  test("does NOT redirect when query param has a non-default value", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const route = result.routes.find((r) => r.pattern === "/query-default");
    if (!route) {
      throw new Error("No query-default route in fixtures");
    }

    const app = new Elysia().use(createRoutePlugin(route, result.root));

    const res = await app.handle(new Request("http://localhost/query-default?city=Tokyo"));

    expect(res.status).toBe(200);
  });

  test("does NOT redirect for route without query schema", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find((r) => r.mode === "ssg");
    if (!ssgRoute) {
      return;
    }

    const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));

    const res = await app.handle(new Request(`http://localhost${ssgRoute.pattern}`));

    expect(res.status).toBe(200);
  });
});

describe("queryDefaultRedirectHook (unit)", () => {
  // The hook uses Elysia's ctx.status("Found") to signal 302 and sets
  // ctx.set.headers.location. We mock status() to return a sentinel value.
  const mockStatus = (code: string) => `status:${code}`;

  test("returns truthy and sets location when key is absent from URL but present in ctx.query", () => {
    const mockCtx = {
      request: new Request("http://localhost/"),
      query: { city: "Paris" },
      set: { headers: {} as Record<string, string> },
      status: mockStatus,
    };

    const result = queryDefaultRedirectHook(mockCtx as never);

    expect(result).toBeTruthy();
    expect(mockCtx.set.headers.location).toBe("/?city=Paris");
  });

  test("returns undefined when all keys are present in URL", () => {
    const mockCtx = {
      request: new Request("http://localhost/?city=Tokyo"),
      query: { city: "Tokyo" },
      set: { headers: {} as Record<string, string> },
      status: mockStatus,
    };

    const result = queryDefaultRedirectHook(mockCtx as never);

    expect(result).toBeUndefined();
  });

  test("returns undefined when ctx.query is empty", () => {
    const mockCtx = {
      request: new Request("http://localhost/"),
      query: {},
      set: { headers: {} as Record<string, string> },
      status: mockStatus,
    };

    const result = queryDefaultRedirectHook(mockCtx as never);

    expect(result).toBeUndefined();
  });

  test("redirects only for absent keys when some params are present", () => {
    const mockCtx = {
      request: new Request("http://localhost/?tag=react"),
      query: { tag: "react", city: "Paris" },
      set: { headers: {} as Record<string, string> },
      status: mockStatus,
    };

    const result = queryDefaultRedirectHook(mockCtx as never);

    expect(result).toBeTruthy();
    expect(mockCtx.set.headers.location).toContain("tag=react");
    expect(mockCtx.set.headers.location).toContain("city=Paris");
  });
});
