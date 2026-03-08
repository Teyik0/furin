import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRoute } from "../../src/client";
import { scanRootLayout } from "../../src/router";
import { collectRouteChainFromRoute, hasCycle, validateRouteChain } from "../../src/utils";

const MUST_INHERIT_FROM_ROOT_RE = /must inherit from root/i;
const CYCLE_RE = /cycle/i;

describe("route chain validation (pure functions)", () => {
  describe("collectRouteChainFromRoute", () => {
    test("returns single route when no parent", () => {
      const route: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      expect(collectRouteChainFromRoute(route)).toEqual([route]);
    });

    test("returns chain in correct order (parent first)", () => {
      const root: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const child: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: root };
      const grandchild: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: child };

      expect(collectRouteChainFromRoute(grandchild)).toEqual([root, child, grandchild]);
    });
  });

  describe("hasCycle", () => {
    test("returns false for route without parent", () => {
      const route: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      expect(hasCycle(route)).toBe(false);
    });

    test("returns false for valid chain", () => {
      const root: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const child: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: root };
      expect(hasCycle(child)).toBe(false);
    });

    test("returns true for direct self-cycle", () => {
      const route: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      route.parent = route;
      expect(hasCycle(route)).toBe(true);
    });

    test("returns true for indirect cycle A→B→A", () => {
      const routeA: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const routeB: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: routeA };
      routeA.parent = routeB;
      expect(hasCycle(routeA)).toBe(true);
      expect(hasCycle(routeB)).toBe(true);
    });
  });

  describe("validateRouteChain", () => {
    test("throws when chain does not contain root", () => {
      const root: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const otherRoute: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const chain = [otherRoute];

      expect(() => validateRouteChain(chain, root)).toThrow(MUST_INHERIT_FROM_ROOT_RE);
    });

    test("succeeds when chain contains root", () => {
      const root: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const child: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: root };
      const chain = [root, child];

      expect(() => validateRouteChain(chain, root)).not.toThrow();
    });

    test("succeeds when level-3 page uses root directly (skips level-2)", () => {
      const root: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const level3DirectRoot: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: root };

      const chain = [root, level3DirectRoot];

      expect(() => validateRouteChain(chain, root)).not.toThrow();
    });

    test("throws when cycle is detected", () => {
      const root: RuntimeRoute = { __type: "ELYRA_ROUTE" };
      const cyclicRoute: RuntimeRoute = { __type: "ELYRA_ROUTE", parent: root };
      cyclicRoute.parent = cyclicRoute;

      const chain = [root, cyclicRoute];

      expect(() => validateRouteChain(chain, root)).toThrow(CYCLE_RE);
    });
  });
});

describe("scanRootLayout", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `elysion-router-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("returns null when root.tsx doesn't exist", async () => {
    const emptyDir = join(tempDir, "no-root");
    mkdirSync(emptyDir, { recursive: true });

    const result = await scanRootLayout(emptyDir);
    expect(result).toBeNull();
  });

  test("returns null when export is not a valid Elyra route", async () => {
    const invalidDir = join(tempDir, "invalid-root");
    mkdirSync(invalidDir, { recursive: true });

    writeFileSync(join(invalidDir, "root.tsx"), "export const route = { notARoute: true };");

    const result = await scanRootLayout(invalidDir);
    expect(result).toBeNull();
  });

  test("returns null when default export is not a valid route", async () => {
    const invalidDefaultDir = join(tempDir, "invalid-default");
    mkdirSync(invalidDefaultDir, { recursive: true });

    writeFileSync(join(invalidDefaultDir, "root.tsx"), "export default { invalid: true };");

    const result = await scanRootLayout(invalidDefaultDir);
    expect(result).toBeNull();
  });

  test("warns when root has no layout", async () => {
    const noLayoutDir = join(tempDir, "no-layout");
    mkdirSync(noLayoutDir, { recursive: true });

    writeFileSync(
      join(noLayoutDir, "root.tsx"),
      `const route = { __type: "ELYRA_ROUTE" };
export { route };`
    );

    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => logs.push(msg);

    const result = await scanRootLayout(noLayoutDir);

    console.warn = originalWarn;

    expect(result).not.toBeNull();
    expect(result?.route).toBeDefined();
    expect(logs.some((l) => l.includes("no layout"))).toBe(true);
  });

  test("returns root layout when valid", async () => {
    const validDir = join(tempDir, "valid-root");
    mkdirSync(validDir, { recursive: true });

    writeFileSync(
      join(validDir, "root.tsx"),
      `const route = { __type: "ELYRA_ROUTE", layout: () => null };
export { route };`
    );

    const result = await scanRootLayout(validDir);

    expect(result).not.toBeNull();
    expect(result?.path).toContain("root.tsx");
    expect(result?.route).toBeDefined();
    expect(result?.route.layout).toBeDefined();
  });
});
