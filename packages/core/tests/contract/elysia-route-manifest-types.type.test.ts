// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, test } from "bun:test";
import type {
  LinkProps,
  Navigate,
  RouteManifest,
  RouteParamsOf,
  RouteSearch,
} from "@teyik0/furin/link";
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
    .page(({ page }) => page);

const createGeneratedBoardRoute = () =>
  defineRoute()
    .config({
      layout: rootLayout,
      mode: "ssr",
      params: t.Object({ boardId: t.Number() }),
    })
    .page(({ params }) => String(params.boardId));

declare const generatedBoardRoute: ReturnType<typeof createGeneratedBoardRoute>;

const createGeneratedOptionalBoardRoute = () =>
  defineRoute()
    .config({
      layout: rootLayout,
      mode: "ssr",
      params: t.Object({ boardId: t.Optional(t.Number()), locale: t.Optional(t.String()) }),
    })
    .page(({ params }) => params.boardId);

declare const generatedOptionalBoardRoute: ReturnType<typeof createGeneratedOptionalBoardRoute>;

const createGeneratedSlugRoute = () =>
  defineRoute()
    .config({ layout: rootLayout, mode: "ssr", params: t.Object({ slug: t.String() }) })
    .page(({ params }) => params.slug);

declare const generatedSlugRoute: ReturnType<typeof createGeneratedSlugRoute>;

declare const generatedRoute: ReturnType<typeof createGeneratedRoute>;

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/elysia-boards/:boardId": typeof generatedBoardRoute;
    "/elysia-optional-boards/:boardId": typeof generatedOptionalBoardRoute;
    "/elysia-products": typeof generatedRoute;
    "/elysia-slugs/:slug": typeof generatedSlugRoute;
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
    locale?: string;
  }>();
  // Routes without path params expose `undefined` params.
  expectTypeOf<RouteParamsOf<"/elysia-products">>().toEqualTypeOf<undefined>();
  // LinkProps picks the projection up.
  expectTypeOf<LinkProps<"/elysia-boards/:boardId">["params"]>().toEqualTypeOf<
    { boardId: string | number } | undefined
  >();
};

const assertTypedNavigate = (
  navigate: Navigate,
  to: "/elysia-boards/:boardId" | "/elysia-slugs/:slug"
) => {
  navigate({ params: { boardId: 42 }, to: "/elysia-boards/:boardId" });
  navigate({ params: { boardId: "42" }, to: "/elysia-optional-boards/:boardId" });
  navigate({ params: { boardId: "42", locale: "fr" }, to: "/elysia-optional-boards/:boardId" });
  navigate({ search: { page: 2, tag: "bun" }, to: "/elysia-products" });
  navigate({ to: "https://example.com" });
  navigate(
    to === "/elysia-boards/:boardId"
      ? { params: { boardId: 42 }, to }
      : { params: { slug: "bun" }, to }
  );

  // @ts-expect-error union destinations must remain paired with their own params
  navigate({ params: { slug: "bun" }, to });

  // @ts-expect-error required path params must be supplied
  navigate({ to: "/elysia-boards/:boardId" });
  // @ts-expect-error path params retain their schema-derived types
  navigate({ params: { boardId: false }, to: "/elysia-boards/:boardId" });
  // @ts-expect-error a required URL segment cannot be omitted even with an optional schema
  navigate({ params: {}, to: "/elysia-optional-boards/:boardId" });
  // @ts-expect-error undefined cannot fill a required URL segment
  navigate({ params: { boardId: undefined }, to: "/elysia-optional-boards/:boardId" });
  // @ts-expect-error search retains its schema-derived types
  navigate({ search: { page: "two" }, to: "/elysia-products" });
  // @ts-expect-error generated manifests reject unknown internal destinations
  navigate({ to: "/not-a-route" });
};

describe("Elysia RouteMap bridge", () => {
  test("projects generated route keys and query types into client routing", assertRouteMapBridge);
  test("projects path params into typed Link props", assertTypedLinkParams);
  test("types imperative navigation destinations, params, and search", () => {
    expectTypeOf(assertTypedNavigate).toBeFunction();
  });
});
