import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { resolveMode } from "../../../src/server/router/patterns.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { expectDefined } from "../../support/utils.ts";

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures/pages/default");

// These tests verify production scan behaviour (pages imported at startup).
let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("route chain contains layouts", () => {
  let result: Awaited<ReturnType<typeof scanPages>>;
  beforeAll(async () => {
    result = await scanPages({ pagesDir: FIXTURES_DIR, prefix: "", style: "tanstack" });
  });

  test("keeps the page leaf separate from its filesystem layout", () => {
    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expect(nestedRoute).toBeDefined();

    const page = nestedRoute?.page;
    expect(page).toBeDefined();
    expect(page?._route).toBeDefined();
    expect(page?._route?.layout).toBeUndefined();
  });

  test("page._route.parent contains the nearest layout and root ancestor", () => {
    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    const page = nestedRoute?.page;

    expect(page?._route?.parent).toBeDefined();
    expect(page?._route?.parent?.layout).toBeDefined();
    expect(page?._route?.parent?.parent?.layout).toBeDefined();
  });

  test("collectRouteChainFromRoute returns all layouts in order", () => {
    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expectDefined(nestedRoute);
    const chain = collectRouteChainFromRoute(nestedRoute.page._route);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeUndefined();
  });

  test("deeply nested route chain (3 levels)", () => {
    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expectDefined(deepRoute);
    const chain = collectRouteChainFromRoute(deepRoute.page._route);

    expect(chain).toHaveLength(4);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeDefined();
    expect(chain[3]?.layout).toBeUndefined();
  });

  test("a page-level JSX wrapper does not create a route layout", () => {
    const inlineRoute = result.routes.find((r) => r.pattern === "/inline-layout");
    expectDefined(inlineRoute);
    const chain = collectRouteChainFromRoute(inlineRoute.page._route);

    expect(chain).toHaveLength(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeUndefined();
  });

  test("a page can skip intermediate layouts and use root directly", () => {
    const skipRoute = result.routes.find((r) => r.pattern === "/skip-layout");
    expectDefined(skipRoute);
    const chain = collectRouteChainFromRoute(skipRoute.page._route);

    expect(chain).toHaveLength(2);
    expect(chain[0]).toBe(result.root.route);
    expect(chain[1]?.layout).toBeUndefined();
  });

  test("root route is in every page's chain", () => {
    for (const route of result.routes) {
      const chain = collectRouteChainFromRoute(route.page._route);
      const hasRoot = chain.some((r) => r === result.root.route);
      expect(hasRoot, `Route ${route.pattern} should have root in chain`).toBe(true);
    }
  });
});

const withLoader = [{ __type: "FURIN_ROUTE", loader: async () => ({}) }] as RuntimeRoute[];

describe("resolveMode", () => {
  test.each([
    {
      chain: withLoader,
      expected: "isr",
      name: "returns isr when revalidate > 0",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE", revalidate: 60 } },
    },
    {
      chain: [{ __type: "FURIN_ROUTE" }] as RuntimeRoute[],
      expected: "ssg",
      name: "returns ssg when no loader",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" } },
    },
    {
      chain: [
        {
          __type: "FURIN_ROUTE",
          query: {
            properties: { page: { default: 1, type: "number" } },
            type: "object",
          },
        },
      ] as RuntimeRoute[],
      expected: "ssr",
      name: "returns ssr when route chain declares query state",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" } },
    },
    {
      chain: withLoader,
      expected: "ssr",
      name: "returns ssr when the route chain has a loader but no revalidate",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE" } },
    },
    {
      chain: [] as RuntimeRoute[],
      expected: "ssr",
      name: "respects explicit mode ssr",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE", mode: "ssr" } },
    },
    {
      chain: withLoader,
      expected: "ssg",
      name: "respects explicit mode ssg",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE", mode: "ssg" } },
    },
    {
      chain: [] as RuntimeRoute[],
      expected: "isr",
      name: "respects explicit mode isr",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE", mode: "isr" } },
    },
    {
      chain: [] as RuntimeRoute[],
      expected: "ssr",
      name: "detects loader in page",
      page: {
        __type: "FURIN_PAGE",
        _route: { __type: "FURIN_ROUTE" },
        component: () => null,
        loader: async () => ({ data: "test" }),
      },
    },
    {
      chain: withLoader,
      expected: "isr",
      name: "returns isr when revalidate is 0 (explicit ISR with no caching)",
      page: { __type: "FURIN_PAGE", _route: { __type: "FURIN_ROUTE", revalidate: 0 } },
    },
    {
      chain: [] as RuntimeRoute[],
      expected: "isr",
      name: "returns isr when page-level revalidate is 0 (explicit ISR with no caching)",
      page: {
        __type: "FURIN_PAGE",
        _route: { __type: "FURIN_ROUTE" },
        component: () => null,
        loader: async () => ({ data: "test" }),
        revalidate: 0,
      },
    },
  ])("$name", ({ chain, expected, page }) => {
    expect(resolveMode(page as RuntimePage, chain)).toBe(expected);
  });
});

describe("scanPageFiles throw", () => {
  let tempDir: string;

  test("throw error when page has no valid export", () => {
    tempDir = join(tmpdir(), `furin-invalid-page-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(
      join(tempDir, "__root.tsx"),
      `const route = { __type: "FURIN_ROUTE", layout: () => null };
export { route };`
    );

    writeFileSync(join(tempDir, "invalid.tsx"), "export default { notAPage: true };");

    expect(scanPages({ pagesDir: tempDir, prefix: "", style: "tanstack" })).rejects.toThrowError();

    if (existsSync(tempDir)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
