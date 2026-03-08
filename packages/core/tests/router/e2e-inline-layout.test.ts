import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../src/router";
import { collectRouteChainFromRoute } from "../../src/utils";
import { expectDefined } from "../helpers/utils";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

describe("E2E: route chain works without routeFilePaths", () => {
  test("scanPages correctly builds route chain for nested page", async () => {
    const result = await scanPages(FIXTURES_DIR);

    expect(result.root).not.toBeNull();
    expect(result.routes.length).toBeGreaterThan(0);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expectDefined(nestedRoute);

    const chain = collectRouteChainFromRoute(nestedRoute.page._route);

    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
  });

  test("scanPages handles deeply nested layouts (3 levels)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expectDefined(deepRoute);

    const chain = collectRouteChainFromRoute(deepRoute.page._route);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeDefined();
  });

  test("scanPages supports inline layout (no route.tsx needed)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const inlineRoute = result.routes.find((r) => r.pattern === "/inline-layout");
    expectDefined(inlineRoute);
    const chain = collectRouteChainFromRoute(inlineRoute.page._route);

    expect(chain).toHaveLength(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
  });

  test("scanPages supports skipping layouts (level 3 uses root directly)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const skipRoute = result.routes.find((r) => r.pattern === "/skip-layout");
    expectDefined(skipRoute);

    const chain = collectRouteChainFromRoute(skipRoute.page._route);

    expect(chain).toHaveLength(1);
    expect(chain[0]).toBe(result.root?.route);
  });

  test("all routes have root in their chain", async () => {
    const result = await scanPages(FIXTURES_DIR);

    for (const route of result.routes) {
      if (route.page) {
        const chain = collectRouteChainFromRoute(route.page._route);
        const hasRoot = chain.some((r) => r === result.root.route);
        expect(hasRoot, `Route ${route.pattern} should have root in chain`).toBe(true);
      }
    }
  });
});
