// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, expectTypeOf as expectTypeOfInBun, test } from "bun:test";
import type { Navigate, RouteSearch } from "@teyik0/furin/link";
import type { useSearch } from "@teyik0/furin/search";
import { expectTypeOf } from "expect-type";
import { Link } from "../../src/client/link.tsx";

import "@teyik0/furin/routes";

/**
 * Navigation input (what a caller may send: defaulted fields optional) is
 * typed separately from the validated output `useSearch()` reads (defaults
 * applied). Type-only file (see define-route-conflicts.test.ts).
 */

declare const defineRoute: typeof import("../../src/furin.ts").defineRoute;
declare const defineRootRoute: typeof import("../../src/furin.ts").defineRootRoute;
declare const t: typeof import("elysia").t;

/** A Standard Schema whose `page` has a default, like zod's `.default(1)`. */
interface DefaultedQuerySchema {
  readonly "~standard": {
    readonly types?: {
      readonly input: { page?: number; q: string };
      readonly output: { page: number; q: string };
    };
  };
}
declare const defaultedQuery: DefaultedQuerySchema;

const createRoot = () =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => children);
declare const root: ReturnType<typeof createRoot>;

const createDefaultedRoute = () =>
  defineRoute()
    .config({ layout: root, mode: "ssr", query: defaultedQuery })
    .page(({ query }) => query.q);
declare const defaultedRoute: ReturnType<typeof createDefaultedRoute>;

const createOptionalRoute = () =>
  defineRoute()
    .config({
      layout: root,
      mode: "ssr",
      query: t.Object({ page: t.Optional(t.Number({ default: 1 })), tag: t.Optional(t.String()) }),
    })
    .page(() => null);
declare const optionalRoute: ReturnType<typeof createOptionalRoute>;

declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/search-defaulted": typeof defaultedRoute;
    "/search-optional": typeof optionalRoute;
  }
}

const assertInputAndOutput = (navigate: Navigate) => {
  expectTypeOf<RouteSearch<"/search-defaulted">>().toEqualTypeOf<{ page?: number; q: string }>();
  expectTypeOf<ReturnType<typeof useSearch<"/search-defaulted">>[0]>().toEqualTypeOf<{
    page: number;
    q: string;
  }>();

  Link({ search: { q: "x" }, to: "/search-defaulted" });
  navigate({ search: { q: "x" }, to: "/search-defaulted" });
  // @ts-expect-error `q` is required, so `search` is required
  Link({ to: "/search-defaulted" });
  // @ts-expect-error `q` is required, so `search` is required
  navigate({ to: "/search-defaulted" });
  // @ts-expect-error a required search field cannot be omitted
  navigate({ search: { page: 2 }, to: "/search-defaulted" });

  // When every input field is optional, `search` itself stays optional.
  Link({ to: "/search-optional" });
  navigate({ search: { tag: "bun" }, to: "/search-optional" });
};

describe("search input and output types", () => {
  test("navigation input makes defaulted fields optional and requires search when needed", () => {
    expectTypeOfInBun(assertInputAndOutput).toBeFunction();
  });
});
