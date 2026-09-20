import { describe, expect, test } from "bun:test";
import type { RuntimePage, RuntimeRoute } from "../../../src/client/internal/runtime-types.ts";
import { hasStaticParams, resolveStaticParams } from "../../../src/server/render/static-params.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";

function createRoute(routeChain: RuntimeRoute[], page: RuntimePage): ResolvedRoute {
  return {
    mode: "ssg",
    page,
    path: "/app/pages/[city]/[day].tsx",
    pattern: "/:city/:day",
    routeChain,
    segmentBoundaries: [],
  };
}

describe("static params", () => {
  test("composes layout and page params from parent loader data", async () => {
    let rootLoaderCalls = 0;
    let cityLoaderCalls = 0;
    const root: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      loader: () => {
        rootLoaderCalls += 1;
        return { cities: ["paris", "lyon"] };
      },
    };
    const city: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      loader: async ({ cities }) => {
        cityLoaderCalls += 1;
        return { days: (await cities) as string[] };
      },
      staticParams: async ({ cities }) =>
        ((await cities) as string[]).map((value) => ({ city: value })),
    };
    const page: RuntimePage = {
      __type: "FURIN_PAGE",
      _route: { __type: "FURIN_ROUTE" },
      component: () => null,
      staticParams: async ({ days, params }) => [
        { day: `${((await days) as string[])[0]}-${params.city}` },
      ],
    };
    const route = createRoute([root, city], page);

    expect(await resolveStaticParams(route, "http://localhost")).toEqual([
      { city: "paris", day: "paris-paris" },
      { city: "lyon", day: "paris-lyon" },
    ]);
    expect(rootLoaderCalls).toBe(3);
    expect(cityLoaderCalls).toBe(2);
  });

  test("does not execute ancestor loaders when parent data is unused", async () => {
    let loaderCalls = 0;
    const root: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      loader: () => {
        loaderCalls += 1;
        return { unused: true };
      },
    };
    const page: RuntimePage = {
      __type: "FURIN_PAGE",
      _route: { __type: "FURIN_ROUTE" },
      component: () => null,
      staticParams: ({ params }) => [{ ...params, city: "paris" }],
    };
    const route = createRoute([root], page);

    expect(hasStaticParams(route)).toBe(true);
    expect(await resolveStaticParams(route, "http://localhost")).toEqual([{ city: "paris" }]);
    expect(loaderCalls).toBe(0);
  });

  test("uses one ancestor-loader promise per branch", async () => {
    let loaderCalls = 0;
    const root: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      loader: () => {
        loaderCalls += 1;
        return { cities: ["paris"], locale: "fr" };
      },
    };
    const page: RuntimePage = {
      __type: "FURIN_PAGE",
      _route: { __type: "FURIN_ROUTE" },
      component: () => null,
      staticParams: async ({ cities, locale }) => {
        const [values, language] = await Promise.all([cities, locale]);
        return [{ city: `${(values as string[])[0]}-${language as string}` }];
      },
    };
    const route = createRoute([root], page);

    expect(await resolveStaticParams(route, "http://localhost")).toEqual([{ city: "paris-fr" }]);
    expect(loaderCalls).toBe(1);
  });

  test("runs ancestor loaders with the deepest concrete ancestor path", async () => {
    const observedPaths: string[] = [];
    const root: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      loader: ({ path }) => {
        observedPaths.push(path as string);
        return { categories: ["books"] };
      },
      sourcePath: "/app/pages/root.tsx",
    };
    const category: RuntimeRoute = {
      __type: "FURIN_ROUTE",
      loader: ({ path }) => {
        observedPaths.push(path as string);
        return { products: ["novel"] };
      },
      sourcePath: "/app/pages/categories/[category]/_route.tsx",
      staticParams: async ({ categories }) =>
        ((await categories) as string[]).map((categoryName) => ({ category: categoryName })),
    };
    const page: RuntimePage = {
      __type: "FURIN_PAGE",
      _route: { __type: "FURIN_ROUTE" },
      component: () => null,
      staticParams: async ({ products }) =>
        ((await products) as string[]).map((product) => ({ product })),
    };
    const route: ResolvedRoute = {
      ...createRoute([root, category], page),
      path: "/app/pages/categories/[category]/[product].tsx",
      pattern: "/categories/:category/:product",
    };

    expect(await resolveStaticParams(route, "http://localhost")).toEqual([
      { category: "books", product: "novel" },
    ]);
    expect(observedPaths).toEqual(["/", "/categories/books", "/categories/books"]);
  });
});
