import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { expectDefined } from "../../support/utils";

const FIXTURES_DIR = join(import.meta.dirname, "../../fixtures/pages/default");

// These tests verify production scan behaviour (pages imported at startup).
let originalDevMode: boolean;
beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
});
afterAll(() => __setDevMode(originalDevMode));

describe("hydration: SSR and client apply layouts in same order", () => {
  test("root is always at index 0 in routeChain", async () => {
    const result = await scanPages(FIXTURES_DIR);
    expect(result.root).not.toBeNull();

    for (const route of result.routes) {
      const chain = collectRouteChainFromRoute(route.page._route);
      if (chain.length > 0) {
        expect(chain[0]).toBe(result.root?.route);
      }
    }
  });

  test("SSR iterates layouts from index 1 to end (matching client slice(1))", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expectDefined(nestedRoute);

    const chain = collectRouteChainFromRoute(nestedRoute.page._route);

    expect(chain).toHaveLength(3);

    const ssrProcessedIndices: number[] = [];
    for (let i = chain.length - 1; i >= 1; i -= 1) {
      if (chain[i]?.layout) {
        ssrProcessedIndices.push(i);
      }
    }

    expect(ssrProcessedIndices).toEqual([1]);

    const clientLayouts = chain.slice(1).filter((entry) => entry.layout);
    const clientProcessedCount = clientLayouts.length;

    expect(ssrProcessedIndices.length).toBe(clientProcessedCount);
  });

  test("3-level nested route applies layouts in correct order", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expectDefined(deepRoute);

    const chain = collectRouteChainFromRoute(deepRoute.page._route);

    expect(chain).toHaveLength(4);

    const ssrOrder: number[] = [];
    for (let i = chain.length - 1; i >= 1; i -= 1) {
      if (chain[i]?.layout) {
        ssrOrder.push(i);
      }
    }
    expect(ssrOrder).toEqual([2, 1]);

    const clientLayouts = chain.slice(1).filter((entry) => entry.layout);
    const clientOrder: number[] = [];
    for (let i = clientLayouts.length - 1; i >= 0; i -= 1) {
      clientOrder.push(i + 1);
    }

    expect(ssrOrder).toEqual(clientOrder);
  });

  test("all routes have consistent chain structure", async () => {
    const result = await scanPages(FIXTURES_DIR);

    for (const route of result.routes) {
      const chain = collectRouteChainFromRoute(route.page._route);

      if (chain.length > 0) {
        expect(chain[0]).toBe(result.root.route);

        const rootCount = chain.filter((r) => r === result.root.route).length;
        expect(rootCount).toBe(1);
      }
    }
  });
});
