// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, test } from "bun:test";
import type { LinkProps, RouteManifest, RouteParamsOf, RouteSearch } from "@teyik0/furin/link";
import type { useSearch } from "@teyik0/furin/search";
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

const createGeneratedRoute = () =>
  defineRoute()
    .config({
      layout: rootLayout,
      mode: "ssr",
      query: t.Object({ page: t.Number(), tag: t.Optional(t.String()) }),
    })
    .loader(({ query }) => query)
    .page(({ data }) => data.page);

const createGeneratedBoardRoute = () =>
  defineRoute()
    .config({
      layout: rootLayout,
      mode: "ssr",
      params: t.Object({ boardId: t.Number() }),
    })
    .page(({ data, params }) => `${data}:${params.boardId}`);

declare const generatedBoardRoute: ReturnType<typeof createGeneratedBoardRoute>;

const createGeneratedOptionalBoardRoute = () =>
  defineRoute()
    .config({
      layout: rootLayout,
      mode: "ssr",
      params: t.Object({ boardId: t.Optional(t.Number()) }),
    })
    .page(({ params }) => params.boardId);

declare const generatedOptionalBoardRoute: ReturnType<typeof createGeneratedOptionalBoardRoute>;

declare const generatedRoute: ReturnType<typeof createGeneratedRoute>;

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/elysia-boards/:boardId": typeof generatedBoardRoute;
    "/elysia-optional-boards/:boardId": typeof generatedOptionalBoardRoute;
    "/elysia-products": typeof generatedRoute;
  }
}
const assertRouteMapBridge = () => {
  type HasProductsRoute = "/elysia-products" extends keyof RouteManifest ? true : false;

  expectTypeOf<HasProductsRoute>().toEqualTypeOf<true>();
  expectTypeOf<RouteSearch<"/elysia-products">>().toEqualTypeOf<{
    page: number;
    tag?: string;
  }>();
  expectTypeOf<ReturnType<typeof useSearch<"/elysia-products">>[0]>().toEqualTypeOf<{
    page: number;
    tag?: string;
  }>();
};

const assertTypedLinkParams = () => {
  // Schema numbers accept both the number and its URL-string form.
  expectTypeOf<RouteParamsOf<"/elysia-boards/:boardId">>().toEqualTypeOf<{
    boardId: string | number;
  }>();
  expectTypeOf<RouteParamsOf<"/elysia-optional-boards/:boardId">>().toEqualTypeOf<{
    boardId?: string | number;
  }>();
  // Routes without path params expose `undefined` params.
  expectTypeOf<RouteParamsOf<"/elysia-products">>().toEqualTypeOf<undefined>();
  // LinkProps picks the projection up.
  expectTypeOf<LinkProps<"/elysia-boards/:boardId">["params"]>().toEqualTypeOf<
    { boardId: string | number } | undefined
  >();
};

describe("Elysia RouteMap bridge", () => {
  test("projects generated route keys and query types into client routing", assertRouteMapBridge);
  test("projects path params into typed Link props", assertTypedLinkParams);
});
