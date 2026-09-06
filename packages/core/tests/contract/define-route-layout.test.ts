// biome-ignore-all lint/suspicious/noUnusedExpressions: type-level assertions are compile-time only

import { describe, expectTypeOf, test } from "bun:test";

/**
 * Type-level contract for `config({ layout })`: the types-only reference to
 * the layout route whose loader feeds this route's parent data. Optional —
 * omitting it keeps the route parentless. Type-only file (see
 * define-route-conflicts.test.ts for the rationale).
 */

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;
declare const t: typeof import("elysia").t;

const createBoardLayout = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ user: "teyik" }))
    .layout(({ children }) => children);

const createChildWithLayout = () =>
  defineRoute()
    .config({ layout: createBoardLayout(), mode: "ssr" })
    .loader(() => ({ board: "42" }))
    .page(({ data }) => {
      expectTypeOf(data.user).toEqualTypeOf<string>();
      expectTypeOf(data.board).toEqualTypeOf<string>();
      return `${data.user}:${data.board}`;
    });

const createChildWithLayoutAndParams = () =>
  defineRoute()
    .config({
      layout: createBoardLayout(),
      mode: "ssr",
      params: t.Object({ id: t.String() }),
    })
    .loader(({ params }) => {
      expectTypeOf(params.id).toEqualTypeOf<string>();
      return { board: params.id };
    })
    .page(({ data }) => {
      expectTypeOf(data.user).toEqualTypeOf<string>();
      expectTypeOf(data.board).toEqualTypeOf<string>();
      return `${data.user}:${data.board}`;
    });

const createParentlessChild = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(() => ({ board: "42" }))
    .page(({ data }) => {
      expectTypeOf(data).toEqualTypeOf<{ board: string }>();
      return data.board;
    });

const createLegacyParentKey = () =>
  defineRoute()
    .config(
      // @ts-expect-error — the old `parent` key was renamed to `layout`.
      { layout: createBoardLayout(), mode: "ssr", parent: createBoardLayout() }
    )
    .page(() => "unused");

describe("defineRoute config({ layout })", () => {
  test("layout threads the layout loader data into the child's render context", () => {
    expectTypeOf<ReturnType<typeof createChildWithLayout>>().not.toBeNever();
  });

  test("layout composes alongside params", () => {
    expectTypeOf<ReturnType<typeof createChildWithLayoutAndParams>>().not.toBeNever();
  });

  test("omitting layout keeps the route parentless", () => {
    expectTypeOf<ReturnType<typeof createParentlessChild>>().not.toBeNever();
  });

  test("the legacy parent key is rejected", () => {
    expectTypeOf<ReturnType<typeof createLegacyParentKey>>().not.toBeNever();
  });
});
