// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, expect, expectTypeOf as expectTypeOfInBun, test } from "bun:test";
import { t } from "elysia";
import { expectTypeOf } from "expect-type";
import { defineRootRoute, defineRoute, type RouteParams } from "../../src/furin.ts";

/**
 * `defineRoute(id)` reads its parent layout, path params and terminal from the
 * generated `FileRoutes`, augmented here as furin-env.d.ts would. The id is
 * type-only: the runtime route is the unkeyed one.
 */

const root = defineRootRoute()
  .config({ mode: "ssr", query: t.Object({ lang: t.String() }) })
  .layout(({ children }) => children);

const createOrgLayout = () =>
  defineRoute("/[org]/_route")
    .config({ mode: "ssg", params: t.Object({ org: t.Number() }) })
    .loader(() => ({ plan: "pro" as const }))
    .layout(({ children, params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return children;
    });
declare const orgLayout: ReturnType<typeof createOrgLayout>;

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/[org]/_route": {
      kind: "layout";
      pattern: "/:org";
      parent: typeof root;
      pathParams: { org: string };
    };
    "/[org]/projects/[projectId]": {
      kind: "page";
      pattern: "/:org/projects/:projectId";
      parent: typeof orgLayout;
      pathParams: { org: string; projectId: string };
    };
  }
}

const assertInheritedFromTree = () => {
  const project = defineRoute("/[org]/projects/[projectId]")
    .config({ mode: "ssr" })
    .loader(async ({ params, plan, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ projectId: string; org: number }>();
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      expectTypeOf(await plan).toEqualTypeOf<"pro">();
      return { name: params.projectId };
    })
    .page(({ name, params, plan }) => {
      expectTypeOf(name).toEqualTypeOf<string>();
      expectTypeOf(plan).toEqualTypeOf<"pro">();
      expectTypeOf(params).toEqualTypeOf<{ projectId: string; org: number }>();
      return null;
    });
  expectTypeOf<RouteParams<typeof project>>().toEqualTypeOf<{
    projectId: string;
    org: number;
  }>();

  const refined = defineRoute("/[org]/projects/[projectId]")
    .config({ mode: "ssg", params: t.Object({ projectId: t.Number() }) })
    .staticParams(({ params }) => {
      expectTypeOf(params).toEqualTypeOf<{ org?: number }>();
      return [{ projectId: 1 }];
    })
    .page(() => null);
  expectTypeOf<RouteParams<typeof refined>>().toEqualTypeOf<{
    org: number;
    projectId: number;
  }>();
};

const assertKeyedLayoutWiresUnkeyedChildren = () => {
  const settings = defineRoute()
    .config({ layout: orgLayout, mode: "ssg" })
    .page(({ params, plan }) => {
      expectTypeOf(params).toEqualTypeOf<{ org: number }>();
      expectTypeOf(plan).toEqualTypeOf<"pro">();
      return null;
    });
  expectTypeOf(settings).not.toBeNever();
};

const assertRejectedWiring = () => {
  // @ts-expect-error a stale id is not a key of the generated FileRoutes
  defineRoute("/org/projects/[projectId]");

  defineRoute("/[org]/projects/[projectId]").config({
    // @ts-expect-error the parent layout comes from the pages tree
    layout: orgLayout,
    mode: "ssr",
  });

  defineRoute("/[org]/_route")
    .config({ mode: "ssr" })
    // @ts-expect-error a _route file is a layout
    .page(() => null);

  defineRoute("/[org]/projects/[projectId]")
    .config({ mode: "ssr" })
    // @ts-expect-error a page file cannot end with layout()
    .layout(({ children }) => children);
};

describe("keyed defineRoute(id)", () => {
  test("builds the same runtime route as defineRoute() with the matching layout", () => {
    const params = t.Object({ org: t.String(), projectId: t.String() });
    const Page = () => null;
    const keyed = defineRoute("/[org]/projects/[projectId]")
      .config({ mode: "ssr", params, tags: ["projects"] })
      .page(Page);
    const unkeyed = defineRoute()
      .config({ layout: root, mode: "ssr", params, tags: ["projects"] })
      .page(Page);

    const { elysia: keyedApp, ...keyedFields } = keyed;
    const { elysia: unkeyedApp, ...unkeyedFields } = unkeyed;
    expect<unknown>(keyedFields).toEqual(unkeyedFields);
    expect(keyedApp.routes.map(({ method, path }) => `${method} ${path}`)).toEqual(
      unkeyedApp.routes.map(({ method, path }) => `${method} ${path}`)
    );
  });

  test("reads parent, path params and terminal from the generated FileRoutes", () => {
    expectTypeOfInBun(assertInheritedFromTree).toBeFunction();
    expectTypeOfInBun(assertKeyedLayoutWiresUnkeyedChildren).toBeFunction();
    expectTypeOfInBun(assertRejectedWiring).toBeFunction();
  });
});
