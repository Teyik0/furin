// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, expectTypeOf as expectTypeOfInBun, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type { RouteParams } from "../../src/furin.ts";

/**
 * A child inherits its layouts' params and query schemas with the same
 * child-overrides-parent semantics as the runtime `mergeRouteSchemas()`.
 * Type-only file (see define-route-conflicts.test.ts).
 */

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;
declare const t: typeof import("elysia").t;

const createRoot = () =>
  defineRootRoute()
    .config({ mode: "ssr", query: t.Object({ lang: t.String() }) })
    .layout(({ children }) => children);
declare const root: ReturnType<typeof createRoot>;

const createOrgLayout = () =>
  defineRoute("/inheritance/[org]/_route")
    .config({ mode: "ssr", params: t.Object({ org: t.String() }) })
    .layout(({ children, params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: string }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return children;
    });
declare const orgLayout: ReturnType<typeof createOrgLayout>;

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/inheritance/[org]/_route": {
      kind: "layout";
      parent: typeof root;
      pathParams: { org: string };
    };
    "/inheritance/[org]/board": {
      kind: "page";
      parent: typeof orgLayout;
      pathParams: { org: string };
    };
    "/inheritance/[org]/override/_route": {
      kind: "layout";
      parent: typeof orgLayout;
      pathParams: { org: string };
    };
    "/inheritance/[org]/schemaless": {
      kind: "page";
      parent: typeof orgLayout;
      pathParams: { org: string };
    };
  }
}

const assertInheritedContract = () => {
  const board = defineRoute("/inheritance/[org]/board")
    .config({ mode: "ssr", params: t.Object({ id: t.Number() }) })
    .loader(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: string; id: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return { id: params.id };
    })
    .head(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: string; id: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return {};
    })
    .page(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: string; id: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return null;
    });
  expectTypeOf<RouteParams<typeof board>>().toEqualTypeOf<{ org: string; id: number }>();

  const schemaless = defineRoute("/inheritance/[org]/schemaless")
    .config({ mode: "ssg" })
    .staticParams(({ params }) => {
      expectTypeOf(params).toEqualTypeOf<{ org?: string }>();
      return [{}];
    })
    .page(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: string }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return null;
    });
  expectTypeOf<RouteParams<typeof schemaless>>().toEqualTypeOf<{ org: string }>();
};

const assertChildOverridesParent = () => {
  const override = defineRoute("/inheritance/[org]/override/_route")
    .config({
      mode: "ssr",
      params: t.Object({ org: t.Number() }),
      query: t.Object({ lang: t.Optional(t.String()), page: t.Number() }),
    })
    .requestLoader(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang?: string; page: number }>();
      return {};
    })
    .layout(({ children, params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang?: string; page: number }>();
      return children;
    });
  expectTypeOf(override).not.toBeNever();
};

describe("defineRoute schema inheritance", () => {
  test("children inherit layout params and query with child-overrides-parent merging", () => {
    expectTypeOfInBun(assertInheritedContract).toBeFunction();
    expectTypeOfInBun(assertChildOverridesParent).toBeFunction();
  });
});
