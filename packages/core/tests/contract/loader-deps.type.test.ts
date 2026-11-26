// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { expect, test } from "bun:test";
import { t } from "elysia";
import { expectTypeOf } from "expect-type";
import { type DefineRouteConfig, defineRoute } from "../../src/furin.ts";

function assertLoaderDepsTypes() {
  defineRoute("/")
    .config({
      mode: "ssr",
      params: t.Object({ id: t.Number() }),
      query: t.Object({ edit: t.Optional(t.String()), page: t.Number({ default: 1 }) }),
      loaderDeps: ({ edit: _, ...deps }) => {
        expectTypeOf(deps).toEqualTypeOf<{ page: number }>();
        return deps;
      },
    })
    .loader(({ query }) => {
      // The loader keeps the full validated query.
      expectTypeOf(query).toEqualTypeOf<{ edit?: string; page: number }>();
      return { total: query.page };
    })
    .page(({ query, total }) => {
      expectTypeOf(query.edit).toEqualTypeOf<string | undefined>();
      expectTypeOf(total).toEqualTypeOf<number>();
      return null;
    });
  defineRoute("/").config({
    mode: "isr",
    revalidate: 60,
    query: t.Object({ tab: t.String() }),
    loaderDeps: (query) => {
      expectTypeOf(query.tab).toEqualTypeOf<string>();
      // @ts-expect-error loaderDeps reads the validated query only
      query.missing;
      return {};
    },
  });
  const invalidScalar: DefineRouteConfig = {
    mode: "ssr",
    // @ts-expect-error loaderDeps returns an object of dependencies
    loaderDeps: () => "key",
  };
  const invalidAsync: DefineRouteConfig = {
    mode: "ssr",
    // @ts-expect-error loaderDeps is synchronous
    loaderDeps: async () => ({}),
  };
  return [invalidScalar, invalidAsync];
}

test("loaderDeps receives the validated query and keeps loader and page inference", () => {
  expect(assertLoaderDepsTypes).toBeFunction();
});
