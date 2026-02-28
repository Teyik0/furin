import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createRoutePlugin, scanPages } from "../../src/router";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

async function getRoute(pattern: string) {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found`);
  }
  return { route, root: result.root };
}

describe("createRoutePlugin", () => {
  test("creates Elysia instance for SSG route", async () => {
    const { route, root } = await getRoute("/ssg-page");

    const plugin = createRoutePlugin(route, root, false);

    expect(plugin).toBeDefined();
    expect(typeof plugin.use).toBe("function");
    expect(typeof plugin.get).toBe("function");
  });

  test("creates Elysia instance for SSR route", async () => {
    const { route, root } = await getRoute("/ssr-page");

    const plugin = createRoutePlugin(route, root, false);

    expect(plugin).toBeDefined();
    expect(typeof plugin.use).toBe("function");
  });

  test("creates Elysia instance for ISR route", async () => {
    const { route, root } = await getRoute("/isr-page");

    const plugin = createRoutePlugin(route, root, false);

    expect(plugin).toBeDefined();
    expect(typeof plugin.use).toBe("function");
  });

  test("creates Elysia instance for route with loader", async () => {
    const { route, root } = await getRoute("/with-loader");

    const plugin = createRoutePlugin(route, root, false);

    expect(plugin).toBeDefined();
  });

  test("creates Elysia instance for nested route", async () => {
    const { route, root } = await getRoute("/nested/deep");

    const plugin = createRoutePlugin(route, root, false);

    expect(plugin).toBeDefined();
  });

  test("handles null root", async () => {
    const { route } = await getRoute("/ssg-page");

    const plugin = createRoutePlugin(route, null, false);

    expect(plugin).toBeDefined();
  });

  test("handles dev mode", async () => {
    const { route, root } = await getRoute("/ssg-page");

    const plugin = createRoutePlugin(route, root, true);

    expect(plugin).toBeDefined();
  });
});
