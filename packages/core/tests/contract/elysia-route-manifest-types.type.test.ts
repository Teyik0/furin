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
import { useSearch } from "@teyik0/furin/search";
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
  defineRoute("/")
    .config({
      mode: "ssr",
      query: t.Object({ page: t.Number(), tag: t.Optional(t.String()) }),
    })
    .loader(({ query }) => query)
    .page(({ page }) => page);

const createGeneratedBoardRoute = () =>
  defineRoute("/")
    .config({
      mode: "ssr",
      params: t.Object({ boardId: t.Number() }),
      query: t.Object({ page: t.Number() }),
    })
    .page(({ params }) => String(params.boardId));

declare const generatedBoardRoute: ReturnType<typeof createGeneratedBoardRoute>;

const createGeneratedOptionalBoardRoute = () =>
  defineRoute("/")
    .config({
      mode: "ssr",
      params: t.Object({ boardId: t.Optional(t.Number()), locale: t.Optional(t.String()) }),
    })
    .page(({ params }) => params.boardId);

declare const generatedOptionalBoardRoute: ReturnType<typeof createGeneratedOptionalBoardRoute>;

const createGeneratedSlugRoute = () =>
  defineRoute("/")
    .config({ mode: "ssr", params: t.Object({ slug: t.String() }) })
    .page(({ params }) => params.slug);

declare const generatedSlugRoute: ReturnType<typeof createGeneratedSlugRoute>;

declare const generatedRoute: ReturnType<typeof createGeneratedRoute>;

const createOrgLayout = () =>
  defineRoute("/manifest/[org]/_route")
    .config({
      mode: "ssr",
      params: t.Object({ org: t.String() }),
      query: t.Object({ lang: t.String() }),
    })
    .layout(({ children }) => children);
declare const orgLayout: ReturnType<typeof createOrgLayout>;

const createInheritedBoardRoute = () =>
  defineRoute("/manifest/[org]/boards/[boardId]")
    .config({ mode: "ssr", params: t.Object({ boardId: t.Number() }) })
    .page(({ params }) => String(params.boardId));
declare const inheritedBoardRoute: ReturnType<typeof createInheritedBoardRoute>;

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/manifest/[org]/_route": {
      kind: "layout";
      parent: typeof rootLayout;
      pathParams: { org: string };
    };
    "/manifest/[org]/boards/[boardId]": {
      kind: "page";
      parent: typeof orgLayout;
      pathParams: { boardId: string; org: string };
    };
  }
  interface RouteMap {
    "/elysia-boards/:boardId": typeof generatedBoardRoute;
    "/elysia-boards/new": typeof generatedRoute;
    "/elysia-optional-boards/:boardId": typeof generatedOptionalBoardRoute;
    "/elysia-orgs/:org/boards/:boardId": typeof inheritedBoardRoute;
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

const assertConcretePathResolution = (navigate: Navigate, slug: string) => {
  // A concrete path resolves to the pattern it matches.
  expectTypeOf<RouteSearch<"/elysia-boards/42">>().toEqualTypeOf<{ page: number }>();
  // A static route wins over a dynamic sibling, as in the runtime router.
  expectTypeOf<RouteSearch<"/elysia-boards/new">>().toEqualTypeOf<{
    page: number;
    tag?: string;
  }>();
  expectTypeOf<RouteParamsOf<"/elysia-boards/new">>().toEqualTypeOf<undefined>();
  // Template paths resolve against `:param` segments.
  expectTypeOf<RouteSearch<`/elysia-boards/${string}`>>().toEqualTypeOf<{ page: number }>();
  navigate({ search: { page: 1 }, to: "/elysia-boards/42" });
  navigate({ to: `/elysia-slugs/${slug}` });
  // @ts-expect-error a `:param` matches exactly one segment
  navigate({ to: "/elysia-boards/42/extra" });
};

const assertInheritedNavigation = (navigate: Navigate) => {
  expectTypeOf<RouteParamsOf<"/elysia-orgs/:org/boards/:boardId">>().toEqualTypeOf<{
    org: string;
    boardId: string | number;
  }>();
  expectTypeOf<RouteSearch<"/elysia-orgs/:org/boards/:boardId">>().toEqualTypeOf<{
    lang: string;
  }>();
  navigate({
    params: { boardId: 1, org: "furin" },
    search: { lang: "fr" },
    to: "/elysia-orgs/:org/boards/:boardId",
  });
  navigate({
    // @ts-expect-error the layout's path param is part of the child's params
    params: { boardId: 1 },
    search: { lang: "fr" },
    to: "/elysia-orgs/:org/boards/:boardId",
  });
};

const assertLinkDestinations = () => {
  Link({ params: { boardId: 42 }, search: { page: 1 }, to: "/elysia-boards/:boardId" });
  Link({ params: { boardId: "42" }, to: "/elysia-optional-boards/:boardId" });
  Link({ search: { page: 2 }, to: "/elysia-products" });
  Link({ search: { page: 1 }, to: "/elysia-boards/42" });
  // @ts-expect-error a named dynamic route requires its URL segment
  Link({ search: { page: 1 }, to: "/elysia-boards/:boardId" });
  // @ts-expect-error optional schemas do not make path segments optional
  Link({ params: {}, to: "/elysia-optional-boards/:boardId" });
  // @ts-expect-error path params retain their schema types
  Link({ params: { boardId: false }, search: { page: 1 }, to: "/elysia-boards/:boardId" });
  // @ts-expect-error named routes retain their query schema
  Link({ search: { page: "two" }, to: "/elysia-products" });
};

const assertStrictDestinations = (router: Router, href: string) => {
  // External URLs and values typed as plain `string` stay accepted.
  Link({ to: "https://example.com/docs" });
  Link({ to: "mailto:team@example.com" });
  Link({ to: "//cdn.example.com/file.pdf" });
  Link({ to: href });
  router.navigate(href);
  router.prefetch(href);
  router.navigate("/elysia-boards/42?page=2");
  useSearch(href);
  useSearch("/elysia-boards/42");
  // @ts-expect-error <Link> rejects unknown internal destinations
  Link({ to: "/not-a-route" });
  // @ts-expect-error router.navigate(href) rejects unknown internal destinations
  router.navigate("/typo");
  // @ts-expect-error router.prefetch(href) rejects unknown internal destinations
  router.prefetch("/typo", { staleTime: 1 });
  // @ts-expect-error useSearch only reads known routes
  useSearch("/not-a-route");
  // @ts-expect-error an external URL has no route search
  useSearch("https://example.com");
};

const assertTypedNavigate = (
  navigate: Navigate,
  to: "/elysia-boards/:boardId" | "/elysia-slugs/:slug"
) => {
  navigate({ params: { boardId: 42 }, search: { page: 1 }, to: "/elysia-boards/:boardId" });
  navigate({ params: { boardId: "42" }, to: "/elysia-optional-boards/:boardId" });
  navigate({ params: { boardId: "42", locale: "fr" }, to: "/elysia-optional-boards/:boardId" });
  navigate({ search: { page: 2, tag: "bun" }, to: "/elysia-products" });
  navigate({ to: "https://example.com" });
  navigate(
    to === "/elysia-boards/:boardId"
      ? { params: { boardId: 42 }, search: { page: 1 }, to }
      : { params: { slug: "bun" }, to }
  );

  // @ts-expect-error union destinations must remain paired with their own params
  navigate({ params: { slug: "bun" }, to });

  // @ts-expect-error required path params must be supplied
  navigate({ search: { page: 1 }, to: "/elysia-boards/:boardId" });
  // @ts-expect-error path params retain their schema-derived types
  navigate({ params: { boardId: false }, search: { page: 1 }, to: "/elysia-boards/:boardId" });
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
  router.navigate({ params: { boardId: 42 }, search: { page: 1 }, to: "/elysia-boards/:boardId" });
  router.prefetch({
    params: { boardId: 42 },
    search: { page: 1 },
    staleTime: 5000,
    to: "/elysia-boards/:boardId",
  });
  router.prefetch({ to: "/elysia-products", search: { page: 2 } });
  router.navigate("/elysia-boards/42", { replace: true });
  router.prefetch("/elysia-boards/42", { staleTime: 5000 });
  // @ts-expect-error named destinations require their path params
  router.navigate({ search: { page: 1 }, to: "/elysia-boards/:boardId" });
  // @ts-expect-error prefetch uses the same required params
  router.prefetch({ search: { page: 1 }, to: "/elysia-boards/:boardId" });
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
  test("resolves concrete paths against exact route patterns", () => {
    expectTypeOf(assertConcretePathResolution).toBeFunction();
  });
  test("inherits layout params and query in navigation", () => {
    expectTypeOf(assertInheritedNavigation).toBeFunction();
  });
  test("rejects unknown internal destinations everywhere", () => {
    expectTypeOf(assertStrictDestinations).toBeFunction();
  });
  test("requires params for named dynamic links", () => {
    expectTypeOf(assertLinkDestinations).toBeFunction();
  });
  test("types imperative navigation destinations, params, and search", () => {
    expectTypeOf(assertTypedNavigate).toBeFunction();
  });
});
