// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, test } from "bun:test";
import type {
  LinkProps,
  Navigate,
  RouteManifest,
  RouteParamsOf,
  Router,
  RouteSearch,
} from "@teyik0/furin/link";
import type { useSearch } from "@teyik0/furin/search";
import { expectTypeOf } from "expect-type";
import { Link } from "../../src/client/link.tsx";
import { getRouteApi } from "../../src/client.ts";

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
      query: t.Object({ page: t.Number() }),
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
  interface RoutePatternMap {
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
  expectTypeOf<ReturnType<typeof useSearch<"/elysia-boards/:boardId">>[0]>().toEqualTypeOf<{
    page: number;
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
  expectTypeOf<LinkProps<"/elysia-boards/:boardId">["params"]>().toEqualTypeOf<{
    boardId: string | number;
  }>();
};

const assertLinkDestinations = () => {
  Link({ params: { boardId: 42 }, to: "/elysia-boards/:boardId" });
  Link({ params: { boardId: "42" }, to: "/elysia-optional-boards/:boardId" });
  Link({ search: { page: 2 }, to: "/elysia-products" });
  Link({ to: "/elysia-boards/42" });
  // @ts-expect-error a named dynamic route requires its URL segment
  Link({ to: "/elysia-boards/:boardId" });
  // @ts-expect-error optional schemas do not make path segments optional
  Link({ params: {}, to: "/elysia-optional-boards/:boardId" });
  // @ts-expect-error path params retain their schema types
  Link({ params: { boardId: false }, to: "/elysia-boards/:boardId" });
  // @ts-expect-error named routes retain their query schema
  Link({ search: { page: "two" }, to: "/elysia-products" });
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

const assertRouteApi = () => {
  const board = getRouteApi("/elysia-boards/:boardId");
  expectTypeOf<ReturnType<typeof board.useParams>>().toEqualTypeOf<{ boardId: number }>();
  const products = getRouteApi("/elysia-products");
  expectTypeOf<ReturnType<typeof products.useLoaderData>>().toExtend<{
    page: number;
    tag?: string;
  }>();
  expectTypeOf<ReturnType<typeof products.useParams>>().toEqualTypeOf<Record<PropertyKey, never>>();
  // @ts-expect-error route readers require a known pattern, not a concrete URL
  getRouteApi("/elysia-boards/42");
  // @ts-expect-error route readers reject unknown routes
  getRouteApi("/missing-route-api");
  // @ts-expect-error route definitions no longer expose a phantom hook
  generatedRoute.useLoaderData();
};

const assertRouterTargets = (router: Router) => {
  router.navigate({ to: "/elysia-boards/:boardId", params: { boardId: 42 } });
  router.prefetch({ to: "/elysia-boards/:boardId", params: { boardId: 42 }, staleTime: 5000 });
  router.prefetch({ to: "/elysia-products", search: { page: 2 } });
  router.navigate("/elysia-boards/42", { replace: true });
  router.prefetch("/elysia-boards/42", { staleTime: 5000 });
  // @ts-expect-error named destinations require their path params
  router.navigate({ to: "/elysia-boards/:boardId" });
  // @ts-expect-error prefetch uses the same required params
  router.prefetch({ to: "/elysia-boards/:boardId" });
  // @ts-expect-error search retains its schema types
  router.prefetch({ to: "/elysia-products", search: { page: "two" } });
  // @ts-expect-error structured navigation rejects unknown routes
  router.navigate({ to: "/missing-navigation" });
};

describe("Elysia RouteMap bridge", () => {
  test("types active route readers and shared router destinations", () => {
    expectTypeOf(assertRouteApi).toBeFunction();
    expectTypeOf(assertRouterTargets).toBeFunction();
  });
  test("projects generated route keys and query types into client routing", assertRouteMapBridge);
  test("projects path params into typed Link props", assertTypedLinkParams);
  test("requires params for named dynamic links", () => {
    expectTypeOf(assertLinkDestinations).toBeFunction();
  });
  test("types imperative navigation destinations, params, and search", () => {
    expectTypeOf(assertTypedNavigate).toBeFunction();
  });
});
