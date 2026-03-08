import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimePage, RuntimeRoute } from "../../src/client";
import { resolveMode, scanPages } from "../../src/router";
import { collectRouteChainFromRoute } from "../../src/utils";
import { expectDefined } from "../helpers/utils";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");

describe("route chain contains layouts", () => {
  test("page._route contains the page's layout", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expect(nestedRoute).toBeDefined();

    const page = nestedRoute?.page;
    expect(page).toBeDefined();
    expect(page?._route).toBeDefined();
    expect(page?._route?.layout).toBeDefined();
  });

  test("page._route.parent contains the parent layout (root)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    const page = nestedRoute?.page;

    expect(page?._route?.parent).toBeDefined();
    expect(page?._route?.parent?.layout).toBeDefined();
  });

  test("collectRouteChainFromRoute returns all layouts in order", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const nestedRoute = result.routes.find((r) => r.pattern === "/nested");
    expectDefined(nestedRoute);
    const chain = collectRouteChainFromRoute(nestedRoute.page._route);

    expect(chain).toHaveLength(2);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
  });

  test("deeply nested route chain (3 levels)", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const deepRoute = result.routes.find((r) => r.pattern === "/nested/deep");
    expectDefined(deepRoute);
    const chain = collectRouteChainFromRoute(deepRoute.page._route);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.layout).toBeDefined();
    expect(chain[1]?.layout).toBeDefined();
    expect(chain[2]?.layout).toBeDefined();
  });

  test("root route is in every page's chain", async () => {
    const result = await scanPages(FIXTURES_DIR);

    for (const route of result.routes) {
      const chain = collectRouteChainFromRoute(route.page._route);
      const hasRoot = chain.some((r) => r === result.root.route);
      expect(hasRoot, `Route ${route.pattern} should have root in chain`).toBe(true);
    }
  });
});

describe("resolveMode", () => {
  test("returns isr when revalidate > 0", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE", revalidate: 60 },
    } as RuntimePage;
    const chain = [{ __type: "ELYRA_ROUTE", loader: async () => ({}) }] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("isr");
  });

  test("returns ssg when no loader", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE" },
    } as RuntimePage;
    const chain = [{ __type: "ELYRA_ROUTE" }] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("ssg");
  });

  test("returns ssr when has loader but no revalidate", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE" },
    } as RuntimePage;
    const chain = [{ __type: "ELYRA_ROUTE", loader: async () => ({}) }] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("ssr");
  });

  test("respects explicit mode ssr", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE", mode: "ssr" },
    } as RuntimePage;
    const chain = [] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("ssr");
  });

  test("respects explicit mode ssg", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE", mode: "ssg" },
    } as RuntimePage;
    const chain = [{ __type: "ELYRA_ROUTE", loader: async () => ({}) }] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("ssg");
  });

  test("respects explicit mode isr", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE", mode: "isr" },
    } as RuntimePage;
    const chain = [] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("isr");
  });

  test("detects loader in page", () => {
    const page = {
      __type: "ELYRA_PAGE" as const,
      _route: { __type: "ELYRA_ROUTE" as const },
      loader: async () => ({ data: "test" }),
      component: () => null,
    } as RuntimePage;
    const chain = [] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("ssr");
  });

  test("detects loader in route chain", () => {
    const page = {
      __type: "ELYRA_PAGE",
      _route: { __type: "ELYRA_ROUTE" },
    } as RuntimePage;
    const chain = [{ __type: "ELYRA_ROUTE", loader: async () => ({}) }] as RuntimeRoute[];

    expect(resolveMode(page, chain)).toBe("ssr");
  });
});

describe("scanPageFiles warning", () => {
  let tempDir: string;

  test("warns when page has no valid export", async () => {
    tempDir = join(tmpdir(), `elysion-invalid-page-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });

    writeFileSync(
      join(tempDir, "root.tsx"),
      `const route = { __type: "ELYRA_ROUTE", layout: () => null };
export { route };`
    );

    writeFileSync(join(tempDir, "invalid.tsx"), "export default { notAPage: true };");

    const logs: string[] = [];
    const originalWarn = console.warn;
    console.warn = (msg: string) => logs.push(msg);

    const result = await scanPages(tempDir);

    console.warn = originalWarn;

    expect(logs.some((l) => l.includes("Skipping") && l.includes("no valid"))).toBe(true);
    expect(result.routes).toHaveLength(0);

    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
