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

  test("correctly updates chain when intermediate directory has no _route.tsx (gap dir)", async () => {
    // Scenario: /pages/board/thread/page.tsx
    // /pages/board/ has NO _route.tsx (gap directory)
    // /pages/board/thread/ has a _route.tsx
    // Chain has [root, threadRoute] — skipping the board directory.
    // The old code mapped layoutPaths[i] -> chain[i+1], which would incorrectly
    // patch chain[1] (threadRoute) with the board _route.tsx result (which
    // doesn't exist), then miss chain[1] when processing the thread _route.tsx.
    const newThreadLayout = () => "new-thread";

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "thread" },
    ];

    const importFn = (specifier: string) => {
      // board/_route.tsx does not exist → module not found error (ENOENT)
      if (specifier.includes("board/_route.tsx") && !specifier.includes("thread")) {
        const err = new Error("Cannot find module board/_route.tsx");
        (err as { code?: string }).code = "ERR_MODULE_NOT_FOUND";
        return Promise.reject(err);
      }
      if (specifier.includes("thread/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", layout: newThreadLayout },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/board/thread/page.tsx", "/pages/root.tsx", importFn);

    // chain[1] (threadRoute) should be patched with thread's new layout,
    // NOT left untouched because the old code mapped board's missing _route.tsx
    // to chain index 1 and skipped thread's _route.tsx entirely.
    expect((chain[1] as Required<RuntimeRoute>).layout).toBe(newThreadLayout);
    expect((chain[0] as Required<RuntimeRoute>).layout).not.toBe(newThreadLayout);
  });

  test("handles multiple gap directories correctly", async () => {
    // Scenario: /pages/a/b/c/page.tsx
    // /pages/a/ and /pages/a/b/ have NO _route.tsx (gap directories)
    // /pages/a/b/c/ has a _route.tsx
    // Chain has [root, cRoute].
    const newCLayout = () => "new-c";

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "c" },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("/a/_route.tsx") || specifier.includes("/a/b/_route.tsx")) {
        const err = new Error("Cannot find module");
        (err as { code?: string }).code = "ERR_MODULE_NOT_FOUND";
        return Promise.reject(err);
      }
      if (specifier.includes("/a/b/c/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", layout: newCLayout },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/a/b/c/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as Required<RuntimeRoute>).layout).toBe(newCLayout);
  });

  test("skips gap dirs and patches all present _route.tsx files", async () => {
    // Scenario: /pages/a/b/page.tsx
    // /pages/a/ has a _route.tsx
    // /pages/a/b/ has a _route.tsx
    // Chain has [root, aRoute, bRoute].
    const newALayout = () => "new-a";
    const newBLayout = () => "new-b";

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "a" },
      { __type: "FURIN_ROUTE", layout: () => "b" },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("/a/_route.tsx") && !specifier.includes("/a/b/")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", layout: newALayout },
        });
      }
      if (specifier.includes("/a/b/_route.tsx")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", layout: newBLayout },
        });
      }
      return Promise.resolve({});
    };

    await refreshLayoutChain(chain, "/pages/a/b/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as Required<RuntimeRoute>).layout).toBe(newALayout);
    expect((chain[2] as Required<RuntimeRoute>).layout).toBe(newBLayout);
  });

  test("refreshes intermediate layouts declared in _route.ts", async () => {
    const originalLayout = () => "old";
    const newLayout = () => "new";

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: originalLayout },
    ];

    const importFn = (specifier: string) => {
      if (specifier.includes("board/_route.ts?")) {
        return Promise.resolve({
          route: { __type: "FURIN_ROUTE", layout: newLayout },
        });
      }

      const err = new Error(`Cannot find module ${specifier}`);
      (err as { code?: string }).code = "ERR_MODULE_NOT_FOUND";
      return Promise.reject(err);
    };

    await refreshLayoutChain(chain, "/pages/board/page.tsx", "/pages/root.tsx", importFn);

    expect((chain[1] as Required<RuntimeRoute>).layout).toBe(newLayout);
  });
});
