import { describe, test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type { RoutePatternOf } from "../../src/client/router/types.ts";
import "@teyik0/furin/routes";

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;

const createOptionalRoute = () =>
  defineRoute("/optional")
    .config({ mode: "ssr" })
    .page(() => null);
declare const optionalRoute: ReturnType<typeof createOptionalRoute>;

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/:lang?/optional-about": typeof optionalRoute;
    "/optional-board/:boardId/:tab?": typeof optionalRoute;
    "/optional-posts/:id/:page?": typeof optionalRoute;
  }
}

describe("optional path segments in route types", () => {
  test("an optional segment matches with or without its value", () => {
    expectTypeOf<
      RoutePatternOf<"/optional-board/42">
    >().toEqualTypeOf<"/optional-board/:boardId/:tab?">();
    expectTypeOf<
      RoutePatternOf<"/optional-board/42/x">
    >().toEqualTypeOf<"/optional-board/:boardId/:tab?">();
    expectTypeOf<RoutePatternOf<"/optional-about">>().toEqualTypeOf<"/:lang?/optional-about">();
    expectTypeOf<RoutePatternOf<"/fr/optional-about">>().toEqualTypeOf<"/:lang?/optional-about">();
  });

  test("an optional segment only stands for one segment", () => {
    expectTypeOf<RoutePatternOf<"/optional-posts">>().toBeNever();
    expectTypeOf<RoutePatternOf<"/optional-board/42/x/y">>().toBeNever();
  });
});
