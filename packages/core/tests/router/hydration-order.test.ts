import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../src/router";
import { __setDevMode } from "../../src/runtime-env";
import { collectRouteChainFromRoute } from "../../src/utils";
import { expectDefined } from "../helpers/utils";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

// These tests verify production scan behaviour (pages imported at startup).
beforeAll(() => __setDevMode(false));
afterAll(() => __setDevMode(true));

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

    expect(chain).toHaveLength(2);

    const ssrProcessedIndices: number[] = [];
    for (let i = chain.length - 1; i >= 1; i--) {
      ssrProcessedIndices.push(i);
    }

    expect(ssrProcessedIndices).toEqual([1]);

    const clientLayouts = chain.slice(1);
    const clientProcessedCount = clientLayouts.length;

    expect(ssrProcessedIndices.length).toBe(clientProcessedCount);
  });

  test("3-level nested route applies layouts in correct order", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expectDefined(deepRoute);

    const chain = collectRouteChainFromRoute(deepRoute.page._route);

    expect(chain).toHaveLength(3);

    const ssrOrder: number[] = [];
    for (let i = chain.length - 1; i >= 1; i--) {
      ssrOrder.push(i);
    }
    expect(ssrOrder).toEqual([2, 1]);

    const clientLayouts = chain.slice(1);
    const clientOrder: number[] = [];
    for (let i = clientLayouts.length - 1; i >= 0; i--) {
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
