import { describe, expect, test } from "bun:test";
import type { RuntimeRoute } from "../../src/client.ts";
import { refreshLayoutChain } from "../../src/router.ts";

describe("refreshLayoutChain", () => {
  test("patches layout on intermediate route chain objects after re-import", async () => {
    const originalLayout = () => "old";
    const newLayout = () => "new";

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: originalLayout },
      { __type: "FURIN_ROUTE", layout: () => "page" },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("board/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", layout: newLayout },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as Required<RuntimeRoute>).layout).toBe(newLayout);
    expect((chain[0] as Required<RuntimeRoute>).layout).not.toBe(newLayout);
    expect((chain[2] as Required<RuntimeRoute>).layout).not.toBe(newLayout);
  });

  test("patches loader on intermediate route chain objects", async () => {
    const originalLoader = () => ({ old: true });
    const newLoader = () => ({ new: true });

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", loader: () => ({ root: true }) },
      { __type: "FURIN_ROUTE", loader: originalLoader },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("board/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", loader: newLoader },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as Required<RuntimeRoute>).loader).toBe(newLoader);
  });

  test("removes stale layout when _route.tsx no longer exports one", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("board/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE" },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as RuntimeRoute | undefined)?.layout).toBeUndefined();
    expect((chain[0] as RuntimeRoute | undefined)?.layout).toBeDefined();
  });

  test("removes stale loader when _route.tsx no longer exports one", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", loader: () => ({ root: true }) },
      { __type: "FURIN_ROUTE", loader: () => ({ board: true }) },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("board/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE" },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as RuntimeRoute | undefined)?.loader).toBeUndefined();
    expect((chain[0] as RuntimeRoute | undefined)?.loader).toBeDefined();
  });

  test("ignores missing layout files silently", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = () => Promise.reject(new Error("Module not found"));

    await expect(
      refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn)
    ).resolves.toBeUndefined();

    expect(typeof (chain[1] as Required<RuntimeRoute>).layout).toBe("function");
  });

  test("re-throws non-not-found import errors", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = () => Promise.reject(new Error("Unexpected syntax error"));

    await expect(
      refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn)
    ).rejects.toThrow("Unexpected syntax error");
  });
});
