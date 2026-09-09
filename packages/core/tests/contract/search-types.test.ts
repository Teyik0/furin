// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, test } from "bun:test";
import type { EmptyRouteSearch, useSearch } from "@teyik0/furin/search";
import { expectTypeOf } from "expect-type";

import "@teyik0/furin/routes";

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;
declare const t: typeof import("elysia").t;

const createRootLayout = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => children);
declare const rootLayout: ReturnType<typeof createRootLayout>;

const createProductsRoute = () =>
  defineRoute()
    .config({
      layout: rootLayout,
      mode: "ssr",
      query: t.Object({ page: t.Number(), tag: t.Optional(t.String()) }),
    })
    .page(() => null);

const createRootRoute = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .page(() => null);

declare const productsRoute: ReturnType<typeof createProductsRoute>;
declare const rootRoute: ReturnType<typeof createRootRoute>;

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/": typeof rootRoute;
    "/products": typeof productsRoute;
  }
}

describe("@teyik0/furin/search types", () => {
  test("reads search types from the generated route manifest", () => {
    expectTypeOf<ReturnType<typeof useSearch<"/products">>[0]>().toEqualTypeOf<{
      page: number;
      tag?: string;
    }>();
    expectTypeOf<ReturnType<typeof useSearch<"/">>[0]>().toEqualTypeOf<EmptyRouteSearch>();
  });

  test("types tuple setSearch input from the route manifest", () => {
    type SetProductsSearch = ReturnType<typeof useSearch<"/products">>[1];

    expectTypeOf<SetProductsSearch>().toBeCallableWith({ page: 2 });
    expectTypeOf<SetProductsSearch>().toBeCallableWith((prev) => ({ page: prev.page + 1 }));
    expectTypeOf<SetProductsSearch>().parameter(0).not.toExtend<{ missing: true }>();
  });
});
