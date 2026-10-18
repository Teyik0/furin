// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, expectTypeOf as expectTypeOfInBun, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type { RouteLoaderData, RouteParams } from "../../src/furin.ts";

/**
 * Pins the public inference of the route builder: params, query, loader data,
 * inherited parent data, head context, page props, stage availability, mode
 * restrictions and requestLoader rules. Type-only file (see
 * define-route-conflicts.test.ts); assertions run via `bun run tscheck`.
 */

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;
declare const t: typeof import("elysia").t;

type NoFields = NonNullable<unknown>;

type Props<Route> = Route extends { component: (props: infer Value) => unknown } ? Value : never;
type HeadContext<Route> = Route extends { head: ((context: infer Value) => unknown) | undefined }
  ? Value
  : never;

const createRoot = () =>
  defineRootRoute()
    .config({ mode: "ssg" })
    .loader(() => ({ site: "Furin" }))
    .layout(({ children, site }) => {
      expectTypeOf(site).toEqualTypeOf<string>();
      return children;
    });
declare const root: ReturnType<typeof createRoot>;

const assertSchemaVariants = () => {
  const plain = defineRoute()
    .config({ layout: root, mode: "ssg" })
    .loader(({ params, query, site }) => {
      expectTypeOf(params).toEqualTypeOf<NoFields>();
      expectTypeOf(query).toEqualTypeOf<NoFields>();
      expectTypeOf(site).toEqualTypeOf<Promise<string>>();
      return { title: "plain" };
    })
    .page((props) => props.title);
  expectTypeOf<Props<typeof plain>["params"]>().toEqualTypeOf<NoFields>();
  expectTypeOf<Props<typeof plain>["title"]>().toEqualTypeOf<string>();
  expectTypeOf<Props<typeof plain>["site"]>().toEqualTypeOf<string>();
  expectTypeOf<RouteLoaderData<typeof plain>>().toExtend<{ site: string; title: string }>();
  expectTypeOf<typeof plain.mode>().toEqualTypeOf<"ssg">();
  expectTypeOf<"schemas" extends keyof typeof plain ? true : false>().toEqualTypeOf<false>();
  expectTypeOf<"loader" extends keyof typeof plain ? true : false>().toEqualTypeOf<true>();

  const queryOnly = defineRoute()
    .config({ layout: root, mode: "ssr", query: t.Object({ page: t.Number() }) })
    .loader(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<NoFields>();
      expectTypeOf(query).toEqualTypeOf<{ page: number }>();
      return { page: query.page };
    })
    .head(({ page, query }) => {
      expectTypeOf(page).toEqualTypeOf<number>();
      expectTypeOf(query).toEqualTypeOf<{ page: number }>();
      return {};
    })
    .page(({ query }) => query.page);
  expectTypeOf<Props<typeof queryOnly>["query"]>().toEqualTypeOf<{ page: number }>();
  expectTypeOf<keyof (typeof queryOnly)["schemas"]>().toEqualTypeOf<"query">();
  expectTypeOf<HeadContext<typeof queryOnly>["page"]>().toEqualTypeOf<number>();

  const paramsOnly = defineRoute()
    .config({ layout: root, mode: "ssr", params: t.Object({ id: t.String() }) })
    .page(({ params, query }) => {
      expectTypeOf(params).toEqualTypeOf<{ id: string }>();
      expectTypeOf(query).toEqualTypeOf<NoFields>();
      return params.id;
    });
  expectTypeOf<RouteParams<typeof paramsOnly>>().toEqualTypeOf<{ id: string }>();
  expectTypeOf<keyof (typeof paramsOnly)["schemas"]>().toEqualTypeOf<"params" | "query">();
  expectTypeOf<"loader" extends keyof typeof paramsOnly ? true : false>().toEqualTypeOf<false>();

  const both = defineRoute()
    .config({
      layout: root,
      mode: "isr",
      params: t.Object({ id: t.Number() }),
      query: t.Object({ tab: t.Optional(t.String()) }),
      revalidate: 60,
    })
    .loader(({ params, query }) => ({ id: params.id, tab: query.tab }))
    .page((props) => {
      expectTypeOf(props.params).toEqualTypeOf<{ id: number }>();
      expectTypeOf(props.query).toEqualTypeOf<{ tab?: string }>();
      expectTypeOf(props.path).toEqualTypeOf<string>();
      expectTypeOf(props.tab).toEqualTypeOf<string | undefined>();
      return null;
    });
  expectTypeOf<RouteParams<typeof both>>().toEqualTypeOf<{ id: number }>();
  expectTypeOf<typeof both.revalidate>().toEqualTypeOf<number | undefined>();
};

const assertStageAvailability = () => {
  const ssr = defineRoute().config({ layout: root, mode: "ssr" });
  expectTypeOf<keyof typeof ssr>().toEqualTypeOf<
    "head" | "layout" | "loader" | "page" | "requestLoader"
  >();
  const ssg = defineRoute().config({ layout: root, mode: "ssg" });
  expectTypeOf<keyof typeof ssg>().toEqualTypeOf<
    "head" | "layout" | "loader" | "page" | "requestLoader" | "staticParams"
  >();
  expectTypeOf<keyof ReturnType<typeof ssg.staticParams>>().toEqualTypeOf<
    "head" | "layout" | "loader" | "page" | "requestLoader"
  >();
  expectTypeOf<keyof ReturnType<typeof ssg.requestLoader>>().toEqualTypeOf<
    "head" | "layout" | "loader" | "page" | "requestLoader"
  >();
  expectTypeOf<keyof ReturnType<typeof ssg.head>>().toEqualTypeOf<"page">();
  const loaded = ssg.loader(() => ({ ready: true }));
  expectTypeOf<keyof typeof loaded>().toEqualTypeOf<"head" | "layout" | "page">();
  expectTypeOf<
    Exclude<keyof ReturnType<typeof loaded.head>, "head" | "layout">
  >().toEqualTypeOf<"page">();
};

const assertRequestLoaderData = () => {
  const route = defineRoute()
    .config({ layout: root, mode: "isr", query: t.Object({ q: t.String() }), revalidate: 1 })
    .requestLoader(({ query, cookies }) => {
      expectTypeOf(query).toEqualTypeOf<{ q: string }>();
      return { user: cookies.get("user"), q: query.q };
    })
    .loader(({ query, ...context }) => {
      expectTypeOf(query).toEqualTypeOf<{ q: string }>();
      // @ts-expect-error request data never reaches a public loader
      context.user;
      return { catalog: "Shoes" };
    })
    .page((props) => {
      expectTypeOf(props.user).toEqualTypeOf<Promise<unknown>>();
      expectTypeOf(props.q).toEqualTypeOf<Promise<string>>();
      expectTypeOf(props.catalog).toEqualTypeOf<string>();
      return null;
    });
  expectTypeOf<RouteLoaderData<typeof route>>().toExtend<{ catalog: string; site: string }>();

  const layout = defineRoute()
    .config({ layout: root, mode: "ssr" })
    .requestLoader(() => ({ session: "private" }))
    .layout(({ children }) => children);
  const child = defineRoute()
    .config({ layout, mode: "ssr" })
    .page((props) => {
      expectTypeOf(props.session).toExtend<Promise<string>>();
      expectTypeOf(props.site).toEqualTypeOf<string>();
      return null;
    });
  expectTypeOf(child).not.toBeNever();
};

const assertRootStages = () => {
  const rootQuery = defineRootRoute()
    .config({ mode: "ssr", query: t.Object({ lang: t.String() }) })
    .layout(({ children, query }) => {
      expectTypeOf(query).toEqualTypeOf<{ lang: string }>();
      return children;
    });
  expectTypeOf<Props<typeof rootQuery>["children"]>().toEqualTypeOf<React.ReactNode>();
  const rootParams = defineRootRoute()
    .config({ mode: "ssg", params: t.Object({ org: t.String() }) })
    .staticParams(() => [{ org: "furin" }])
    .page(({ params }) => params.org);
  expectTypeOf<RouteParams<typeof rootParams>>().toEqualTypeOf<{ org: string }>();
};

describe("defineRoute inference contract", () => {
  test("pins params, query, data, head, page props and stage availability", () => {
    expectTypeOfInBun(assertSchemaVariants).toBeFunction();
    expectTypeOfInBun(assertStageAvailability).toBeFunction();
    expectTypeOfInBun(assertRequestLoaderData).toBeFunction();
    expectTypeOfInBun(assertRootStages).toBeFunction();
  });
});
