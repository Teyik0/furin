import { describe, expect, test } from "bun:test";
import type { Cookie, StatusMap } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { expectTypeOf } from "expect-type";
import { createRoute, type InferProps, type RouteContext } from "../src/client";

describe("RouteContext types", () => {
  test("exposes Elysia context properties", () => {
    type Ctx = RouteContext<{ id: string }, { page: number }>;

    expectTypeOf<Ctx["params"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Ctx["query"]>().toEqualTypeOf<{ page: number }>();
    expectTypeOf<Ctx["request"]>().toEqualTypeOf<Request>();
    expectTypeOf<Ctx["headers"]>().toEqualTypeOf<Record<string, string | undefined>>();
    expectTypeOf<Ctx["cookie"]>().toEqualTypeOf<Record<string, Cookie<unknown>>>();
    expectTypeOf<Ctx["redirect"]>().toBeCallableWith("/login", 302);
    expectTypeOf<Ctx["redirect"]>().returns.toEqualTypeOf<Response>();
    expectTypeOf<Ctx["set"]>().toEqualTypeOf<{
      headers: HTTPHeaders;
      status?: number | keyof StatusMap;
    }>();
    expectTypeOf<Ctx["path"]>().toEqualTypeOf<string>();
  });

  test("loader receives extended context with cookie and redirect", () => {
    const route = createRoute({
      loader: (ctx) => {
        expectTypeOf(ctx.request).toEqualTypeOf<Request>();
        expectTypeOf(ctx.headers).toEqualTypeOf<Record<string, string | undefined>>();
        expectTypeOf(ctx.cookie).toEqualTypeOf<Record<string, Cookie<unknown>>>();
        expectTypeOf(ctx.redirect).toBeCallableWith("/login", 302);
        expectTypeOf(ctx.set).toEqualTypeOf<{
          headers: HTTPHeaders;
          status?: number | keyof StatusMap;
        }>();
        expectTypeOf(ctx.path).toEqualTypeOf<string>();
        return { data: "test" };
      },
    });

    expect(route).toBeDefined();
  });

  test("component receives context + loader data", () => {
    const route = createRoute({
      loader: async () => ({ user: { name: "test" } }),
    });

    const page = route.page({
      component: (props) => {
        expectTypeOf(props.user).toEqualTypeOf<{ name: string }>();
        expectTypeOf(props.request).toEqualTypeOf<Request>();
        expectTypeOf(props.cookie).toEqualTypeOf<Record<string, Cookie<unknown>>>();
        expectTypeOf(props.redirect).toBeCallableWith("/login", 302);
        expectTypeOf(props.path).toEqualTypeOf<string>();
        return null;
      },
    });

    expect(page).toBeDefined();
  });

  test("parent data merges with context in child loader", () => {
    const parentRoute = createRoute({
      loader: async () => ({ org: { id: "org-1" } }),
    });

    const childRoute = createRoute({
      parent: parentRoute,
      loader: (ctx) => {
        expectTypeOf(ctx.org).toEqualTypeOf<{ id: string }>();
        expectTypeOf(ctx.request).toEqualTypeOf<Request>();
        expectTypeOf(ctx.cookie).toEqualTypeOf<Record<string, Cookie<unknown>>>();
        return { user: { name: "test" } };
      },
    });

    expect(childRoute).toBeDefined();
  });

  test("InferProps includes context properties", () => {
    const route = createRoute({
      loader: async () => ({ count: 42 }),
    });

    type Props = InferProps<typeof route>;

    expectTypeOf<Props["count"]>().toEqualTypeOf<number>();
    expectTypeOf<Props["request"]>().toEqualTypeOf<Request>();
    expectTypeOf<Props["cookie"]>().toEqualTypeOf<Record<string, Cookie<unknown>>>();
  });
});
