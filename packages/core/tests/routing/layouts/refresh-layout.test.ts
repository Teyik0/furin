import { describe, expect, test } from "bun:test";
import type { RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { defineRootRoute } from "../../../src/furin.ts";
import { refreshLayoutChain } from "../../../src/server/router/hmr.ts";

const BOARD_LAYOUT = "/pages/board/route.tsx";

function layoutModule(layout: () => string) {
  return { route: defineRootRoute().config({ mode: "ssr" }).layout(layout) };
}

describe("refreshLayoutChain", () => {
  test("patches layout on intermediate route chain objects after re-import", async () => {
    const originalLayout = () => "old";
    const newLayout = () => "new";

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: originalLayout },
      { __type: "FURIN_ROUTE", layout: () => "page" },
    ];

    const importFn = (specifier: string) =>
      Promise.resolve(specifier.includes(BOARD_LAYOUT) ? layoutModule(newLayout) : {});

    await refreshLayoutChain(chain, [BOARD_LAYOUT], importFn);

    expect((chain[1] as Required<RuntimeRoute>).layout({} as never)).toBe("new");
    expect((chain[0] as Required<RuntimeRoute>).layout({} as never)).toBe("root");
    expect((chain[2] as Required<RuntimeRoute>).layout({} as never)).toBe("page");
  });

  test("patches loader on intermediate route chain objects", async () => {
    const originalLoader = () => ({ old: true });
    const newLoader = () => ({ new: true });

    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", loader: () => ({ root: true }) },
      { __type: "FURIN_ROUTE", loader: originalLoader },
    ];

    const importFn = (specifier: string) =>
      Promise.resolve(
        specifier.includes(BOARD_LAYOUT)
          ? {
              route: defineRootRoute()
                .config({ mode: "ssr" })
                .loader(newLoader)
                .layout(({ children }) => children),
            }
          : {}
      );

    await refreshLayoutChain(chain, [BOARD_LAYOUT], importFn);

    expect((chain[1] as Required<RuntimeRoute>).loader).toBe(newLoader);
  });

  test("patches TanStack-style boundaries on the layout entry", async () => {
    const BoardError = () => null;
    const BoardNotFound = () => null;
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = () =>
      Promise.resolve({
        route: defineRootRoute()
          .config({ mode: "ssr" })
          .error(BoardError)
          .notFound(BoardNotFound)
          .layout(({ children }) => children),
      });

    await refreshLayoutChain(chain, [BOARD_LAYOUT], importFn);

    expect(chain[1]?.errorComponent).toBe(BoardError);
    expect(chain[1]?.notFoundComponent).toBe(BoardNotFound);
  });

  test("rejects with the layout export contract while the layout has no layout terminal", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = () =>
      Promise.resolve({
        route: defineRootRoute()
          .config({ mode: "ssr" })
          .page(() => null),
      });

    const failure = await refreshLayoutChain(chain, [BOARD_LAYOUT], importFn).catch(
      (error: unknown) => error
    );

    expect(String((failure as Error).cause)).toContain(
      `${BOARD_LAYOUT}: a layout file must export \`route = defineRoute(id)`
    );
    expect(Reflect.get((failure as Error).cause as Error, "furinPosition")).toEqual({
      column: 1,
      file: BOARD_LAYOUT,
      line: 1,
    });
  });

  test("removes stale loader when the layout no longer exports one", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", loader: () => ({ root: true }) },
      { __type: "FURIN_ROUTE", loader: () => ({ board: true }) },
    ];

    const importFn = () =>
      Promise.resolve({
        route: defineRootRoute()
          .config({ mode: "ssr" })
          .layout(({ children }) => children),
      });

    await refreshLayoutChain(chain, [BOARD_LAYOUT], importFn);

    expect((chain[1] as RuntimeRoute | undefined)?.loader).toBeUndefined();
    expect((chain[0] as RuntimeRoute | undefined)?.loader).toBeDefined();
  });

  test("keeps a layout deleted since the scan until the topology rescan", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = () => Promise.reject(new Error("Module not found"));

    await expect(refreshLayoutChain(chain, [BOARD_LAYOUT], importFn)).resolves.toBeUndefined();

    expect((chain[1] as Required<RuntimeRoute>).layout({} as never)).toBe("board");
  });

  test("re-throws non-not-found import errors", async () => {
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "board" },
    ];

    const importFn = () => Promise.reject(new Error("Unexpected syntax error"));

    await expect(refreshLayoutChain(chain, [BOARD_LAYOUT], importFn)).rejects.toThrow(
      "Unexpected syntax error"
    );
  });

  test("layout i patches chain[i + 1], whatever the files' directories", async () => {
    // TanStack: a pathless `_auth.tsx` and a flat `posts.tsx` wrap pages
    // outside their own directory, so position in layoutPaths is the only link.
    const chain: RuntimeRoute[] = [
      { __type: "FURIN_ROUTE", layout: () => "root" },
      { __type: "FURIN_ROUTE", layout: () => "auth" },
      { __type: "FURIN_ROUTE", layout: () => "posts" },
      { __type: "FURIN_ROUTE", layout: () => "page" },
    ];
    const layouts: { [path: string]: () => string } = {
      "/pages/_auth.tsx": () => "new-auth",
      "/pages/_auth/posts.tsx": () => "new-posts",
    };

    const importFn = (specifier: string) => {
      const path = Object.keys(layouts).find((candidate) => specifier.startsWith(candidate));
      return Promise.resolve(path ? layoutModule(layouts[path] as () => string) : {});
    };

    await refreshLayoutChain(chain, Object.keys(layouts), importFn);

    expect(chain.map((entry) => (entry as Required<RuntimeRoute>).layout({} as never))).toEqual([
      "root",
      "new-auth",
      "new-posts",
      "page",
    ]);
  });
});
