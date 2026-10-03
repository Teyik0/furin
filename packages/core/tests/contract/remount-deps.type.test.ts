// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { expect, test } from "bun:test";
import { t } from "elysia";
import { expectTypeOf } from "expect-type";
import { type DefineRouteConfig, defineRootRoute, defineRoute } from "../../src/furin.ts";

function assertRemountTypes() {
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => children);
  defineRoute()
    .config({
      layout,
      mode: "ssr",
      params: t.Object({ id: t.Number() }),
      query: t.Object({ tab: t.Optional(t.String()) }),
      remountDeps(context) {
        expectTypeOf(context.params.id).toEqualTypeOf<number>();
        expectTypeOf(context.query.tab).toEqualTypeOf<string | undefined>();
        // @ts-expect-error loader fields cannot influence page identity
        context.title;
        // @ts-expect-error unknown path parameters are rejected
        context.params.missing;
        return [context.params.id, context.query.tab];
      },
    })
    .loader(({ params }) => ({ title: String(params.id) }))
    .page(({ title, params }) => {
      expectTypeOf(title).toEqualTypeOf<string>();
      expectTypeOf(params.id).toEqualTypeOf<number>();
      return null;
    });
  defineRoute().config({
    layout,
    mode: "ssg",
    params: t.Object({ slug: t.String() }),
    remountDeps: ({ params, query }) => {
      expectTypeOf(params.slug).toEqualTypeOf<string>();
      expectTypeOf<keyof typeof query>().toEqualTypeOf<never>();
      return [params.slug];
    },
  });
  defineRoute().config({
    layout,
    mode: "isr",
    revalidate: 60,
    query: t.Object({ page: t.Number() }),
    remountDeps: ({ params, query }) => {
      expectTypeOf<keyof typeof params>().toEqualTypeOf<never>();
      expectTypeOf(query.page).toEqualTypeOf<number>();
      return [query.page];
    },
  });
  defineRoute().config({ layout, mode: "ssr", remountDeps: () => [] });
  defineRootRoute().config({
    mode: "ssr",
    params: t.Object({ id: t.String() }),
    query: t.Object({ tab: t.String() }),
    remountDeps: ({ params, query }) => {
      expectTypeOf(params.id).toEqualTypeOf<string>();
      expectTypeOf(query.tab).toEqualTypeOf<string>();
      return [params.id, query.tab];
    },
  });
  const invalidObject: DefineRouteConfig = {
    mode: "ssr",
    // @ts-expect-error dependencies must be primitives, not objects
    remountDeps: () => [{}],
  };
  const invalidAsync: DefineRouteConfig = {
    mode: "ssr",
    // @ts-expect-error page identity must be synchronous
    remountDeps: async () => [],
  };
  const invalidScalar: DefineRouteConfig = {
    mode: "ssr",
    // @ts-expect-error use a dependency array, not a scalar
    remountDeps: () => "key",
  };
  return [invalidObject, invalidAsync, invalidScalar];
}

test("remount dependencies infer validated params and query without loader data", () => {
  expect(assertRemountTypes).toBeFunction();
});
