import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { expectDefined } from "../../support/utils";

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures/pages/default");

beforeAll(() => __setDevMode(false));
afterAll(() => __setDevMode(true));

describe("E2E: route chain works without routeFilePaths", () => {
  test("scanPages correctly builds route chain for nested page", async () => {
    const result = await scanPages(FIXTURES_DIR);

    expect(result.root).not.toBeNull();
    expect(result.routes.length).toBeGreaterThan(0);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expectDefined(nestedRoute);

    const chain = collectRouteChainFromRoute(nestedRoute.page._route);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeUndefined();
  });

  test("scanPages handles deeply nested layouts (3 levels)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expectDefined(deepRoute);

    const chain = collectRouteChainFromRoute(deepRoute.page._route);

    expect(chain).toHaveLength(4);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeDefined();
    expect(chain[3]?.layout).toBeUndefined();
  });

  test("a page-level JSX wrapper does not create a route layout", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const inlineRoute = result.routes.find((r) => r.pattern === "/inline-layout");
    expectDefined(inlineRoute);
    const chain = collectRouteChainFromRoute(inlineRoute.page._route);

    expect(chain).toHaveLength(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeUndefined();
  });

  test("scanPages supports skipping layouts (level 3 uses root directly)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const skipRoute = result.routes.find((r) => r.pattern === "/skip-layout");
    expectDefined(skipRoute);

    const chain = collectRouteChainFromRoute(skipRoute.page._route);

    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(result.root.route);
    expect(chain[1]?.layout).toBeUndefined();
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
