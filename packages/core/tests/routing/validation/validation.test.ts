import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { scanRootLayout } from "../../../src/server/router/discovery.ts";
import {
  collectRouteChainFromRoute,
  hasCycle,
  validateRouteChain,
} from "../../../src/shared/utils/index.ts";

const MUST_INHERIT_FROM_ROOT_RE = /must inherit from root/i;
const CYCLE_RE = /cycle/i;

describe("route chain validation (pure functions)", () => {
  describe("collectRouteChainFromRoute", () => {
    test("returns single route when no parent", () => {
      const route: RuntimeRoute = { __type: "FURIN_ROUTE" };
      expect(collectRouteChainFromRoute(route)).toEqual([route]);
    });

    test("returns chain in correct order (parent first)", () => {
      const root: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const child: RuntimeRoute = { __type: "FURIN_ROUTE", parent: root };
      const grandchild: RuntimeRoute = { __type: "FURIN_ROUTE", parent: child };

      expect(collectRouteChainFromRoute(grandchild)).toEqual([root, child, grandchild]);
    });
  });

  describe("hasCycle", () => {
    test("returns false for route without parent", () => {
      const route: RuntimeRoute = { __type: "FURIN_ROUTE" };
      expect(hasCycle(route)).toBe(false);
    });

    test("returns false for valid chain", () => {
      const root: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const child: RuntimeRoute = { __type: "FURIN_ROUTE", parent: root };
      expect(hasCycle(child)).toBe(false);
    });

    test("returns true for direct self-cycle", () => {
      const route: RuntimeRoute = { __type: "FURIN_ROUTE" };
      route.parent = route;
      expect(hasCycle(route)).toBe(true);
    });

    test("returns true for indirect cycle A→B→A", () => {
      const routeA: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const routeB: RuntimeRoute = { __type: "FURIN_ROUTE", parent: routeA };
      routeA.parent = routeB;
      expect(hasCycle(routeA)).toBe(true);
      expect(hasCycle(routeB)).toBe(true);
    });
  });

  describe("validateRouteChain", () => {
    test("throws when chain does not contain root", () => {
      const root: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const otherRoute: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const chain = [otherRoute];

      expect(() => validateRouteChain(chain, root)).toThrow(MUST_INHERIT_FROM_ROOT_RE);
    });

    test("succeeds when chain contains root", () => {
      const root: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const child: RuntimeRoute = { __type: "FURIN_ROUTE", parent: root };
      const chain = [root, child];

      expect(() => validateRouteChain(chain, root)).not.toThrow();
    });

    test("succeeds when level-3 page uses root directly (skips level-2)", () => {
      const root: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const level3DirectRoot: RuntimeRoute = { __type: "FURIN_ROUTE", parent: root };

      const chain = [root, level3DirectRoot];

      expect(() => validateRouteChain(chain, root)).not.toThrow();
    });

    test("throws when cycle is detected", () => {
      const root: RuntimeRoute = { __type: "FURIN_ROUTE" };
      const cyclicRoute: RuntimeRoute = { __type: "FURIN_ROUTE", parent: root };
      cyclicRoute.parent = cyclicRoute;

      const chain = [root, cyclicRoute];

      expect(() => validateRouteChain(chain, root)).toThrow(CYCLE_RE);
    });
  });
});

describe("scanRootLayout", () => {
  let tempDir: string;

  beforeAll(() => {
    tempDir = join(tmpdir(), `furin-router-test-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(tempDir)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  test("throw error when root.tsx doesn't exist", () => {
    const emptyDir = join(tempDir, "no-root");
    mkdirSync(emptyDir, { recursive: true });

    expect(scanRootLayout(emptyDir)).rejects.toThrow();
  });

  test("throw error when export is not a valid Elyra route", () => {
    const invalidDir = join(tempDir, "invalid-root");
    mkdirSync(invalidDir, { recursive: true });

    writeFileSync(join(invalidDir, "root.tsx"), "export const route = { notARoute: true };");

    expect(scanRootLayout(invalidDir)).rejects.toThrow();
  });

  test("throw error when default export is not a valid route", () => {
    const invalidDefaultDir = join(tempDir, "invalid-default");
    mkdirSync(invalidDefaultDir, { recursive: true });

    writeFileSync(join(invalidDefaultDir, "root.tsx"), "export default { invalid: true };");

    expect(scanRootLayout(invalidDefaultDir)).rejects.toThrow();
  });

  test("rejects a valid route terminal exported as default", () => {
    const defaultRouteDir = join(tempDir, "default-route");
    mkdirSync(defaultRouteDir, { recursive: true });
    const furinEntry = join(import.meta.dir, "../../../src/furin.ts");

    writeFileSync(
      join(defaultRouteDir, "root.tsx"),
      `import { defineRootRoute } from ${JSON.stringify(furinEntry)};
export default defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);`
    );

    expect(scanRootLayout(defaultRouteDir)).rejects.toThrow();
  });

  test("throw error when root has no layout", () => {
    const noLayoutDir = join(tempDir, "no-layout");
    mkdirSync(noLayoutDir, { recursive: true });

    writeFileSync(
      join(noLayoutDir, "root.tsx"),
      `const route = { __type: "FURIN_ROUTE" };
export { route };`
    );

    expect(scanRootLayout(noLayoutDir)).rejects.toThrow();
  });

  test("returns root layout when valid", async () => {
    const validDir = join(tempDir, "valid-root");
    mkdirSync(validDir, { recursive: true });
    const furinEntry = join(import.meta.dir, "../../../src/furin.ts");

    writeFileSync(
      join(validDir, "root.tsx"),
      `import { defineRootRoute } from ${JSON.stringify(furinEntry)};
export const route = defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children);`
    );

    const result = await scanRootLayout(validDir);

    expect(result).not.toBeNull();
    expect(result.path).toContain("root.tsx");
    expect(result.route).toBeDefined();
    expect(result.route.layout).toBeDefined();
  });
});
