// biome-ignore-all lint/complexity/noBannedTypes: for testing purpose

import { describe, expect, test } from "bun:test";
import type { Cookie, StatusMap } from "elysia";
import { t } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { expectTypeOf } from "expect-type";
import {
  type ComponentProps,
  createRoute,
  type InferProps,
  type RouteContext,
} from "../src/client";
import { collectRouteChainFromRoute, isElyraPage, isElyraRoute } from "../src/utils";

describe("RouteContext types (for loaders)", () => {
  test("exposes full Elysia context properties", () => {
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

  test("params and query default to {} when Unset", () => {
    type Ctx = RouteContext;
    expectTypeOf<Ctx["params"]>().toEqualTypeOf<{}>();
    expectTypeOf<Ctx["query"]>().toEqualTypeOf<{}>();
  });

  test("loader receives full context with cookie and redirect", () => {
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
        expectTypeOf(ctx.params).toEqualTypeOf<{}>();
        expectTypeOf(ctx.query).toEqualTypeOf<{}>();
        return { data: "test" };
      },
    });

    expect(route).toBeDefined();
  });
});

describe("ComponentProps types (for components)", () => {
  test("exposes only serializable properties", () => {
    type Props = ComponentProps<{ id: string }, { page: number }>;

    expectTypeOf<Props["params"]>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<Props["query"]>().toEqualTypeOf<{ page: number }>();
    expectTypeOf<Props["path"]>().toEqualTypeOf<string>();
  });

  test("params and query default to {} when Unset", () => {
    type Props = ComponentProps;
    expectTypeOf<Props["params"]>().toEqualTypeOf<{}>();
    expectTypeOf<Props["query"]>().toEqualTypeOf<{}>();
  });

  test("component receives loader data + serializable props only", () => {
    const route = createRoute({
      loader: async () => ({ user: { name: "test" } }),
    });

    const page = route.page({
      component: (props) => {
        expectTypeOf(props.user).toEqualTypeOf<{ name: string }>();
        expectTypeOf(props.params).toEqualTypeOf<{}>();
        expectTypeOf(props.query).toEqualTypeOf<{}>();
        expectTypeOf(props.path).toEqualTypeOf<string>();
        // @ts-expect-error — request is NOT available in components
        props.request;
        // @ts-expect-error — cookie is NOT available in components
        props.cookie;
        // @ts-expect-error — headers is NOT available in components
        props.headers;
        // @ts-expect-error — redirect is NOT available in components
        props.redirect;
        // @ts-expect-error — set is NOT available in components
        props.set;
        return null;
      },
    });

    expect(page).toBeDefined();
  });
});

describe("createRoute types", () => {
  test("simple route — no loader, no layout", () => {
    const route = createRoute({ mode: "ssg" });

    route.page({
      component: (props) => {
        // @ts-expect-error — params is {} so 'foo' doesn't exist
        props.params.foo;
        // @ts-expect-error — query is {} so 'bar' doesn't exist
        props.query.bar;
        return null;
      },
    });
  });

  test("route with loader — data flows to page", () => {
    const route = createRoute({
      loader: async () => ({
        user: { id: 1, name: "Alice" },
        count: 42,
      }),
    });

    route.page({
      component: ({ user, count }) => {
        expectTypeOf(user).toEqualTypeOf<{ id: number; name: string }>();
        expectTypeOf(count).toBeNumber();
        return null;
      },
    });
  });

  test("route with loader + layout — layout sees loader data", () => {
    const route = createRoute({
      loader: async () => ({
        post: { id: 1, title: "Hello" },
      }),
      layout: ({ post, children }) => {
        expectTypeOf(post).toEqualTypeOf<{ id: number; title: string }>();
        expectTypeOf(children).toEqualTypeOf<React.ReactNode>();
        return null;
      },
    });

    route.page({
      component: ({ post }) => {
        expectTypeOf(post).toEqualTypeOf<{ id: number; title: string }>();
        return null;
      },
    });
  });

  test("route with params + query — schemas are inferred", () => {
    const route = createRoute({
      params: t.Object({ slug: t.String() }),
      query: t.Object({ page: t.Optional(t.Number()) }),
      loader: async ({ params }) => ({
        post: { id: 1, slug: params.slug },
      }),
    });

    route.page({
      component: ({ params, post }) => {
        expectTypeOf(params.slug).toBeString();
        expectTypeOf(post).toEqualTypeOf<{ id: number; slug: string }>();
        return null;
      },
    });
  });

  test("loader can use cookie to extract values for component", () => {
    const route = createRoute({
      loader: async ({ cookie }) => ({
        theme: (cookie.theme?.value as string | undefined) ?? "light",
        sessionId: cookie.session?.value as string | undefined,
      }),
    });

    route.page({
      component: ({ theme, sessionId }) => {
        expectTypeOf(theme).toEqualTypeOf<string>();
        expectTypeOf(sessionId).toEqualTypeOf<string | undefined>();
        return null;
      },
    });
  });

  test("loader can use headers to extract values for component", () => {
    const route = createRoute({
      loader: async ({ headers }) => ({
        userAgent: headers["user-agent"],
        acceptLanguage: headers["accept-language"],
      }),
    });

    route.page({
      component: ({ userAgent, acceptLanguage }) => {
        expectTypeOf(userAgent).toEqualTypeOf<string | undefined>();
        expectTypeOf(acceptLanguage).toEqualTypeOf<string | undefined>();
        return null;
      },
    });
  });
});

describe("nested layouts", () => {
  test("parent → child — data propagates flat", () => {
    const parentRoute = createRoute({
      loader: async () => ({
        user: { id: 1, name: "Alice", orgId: "org-1" },
      }),
    });

    const childRoute = createRoute({
      parent: parentRoute,
      loader: ({ user }) => {
        expectTypeOf(user.orgId).toBeString();
        return {
          users: [{ id: 1 }] as Array<{ id: number }>,
        };
      },
    });

    childRoute.page({
      component: ({ user, users }) => {
        expectTypeOf(user.name).toBeString();
        expectTypeOf(users).toEqualTypeOf<Array<{ id: number }>>();
        return null;
      },
    });
  });

  test("triple nesting — grandparent → parent → child", () => {
    const grandparentRoute = createRoute({
      loader: async () => ({ org: { id: "org-1", name: "Acme" } }),
    });

    const parentRoute = createRoute({
      parent: grandparentRoute,
      loader: ({ org }) => {
        expectTypeOf(org.name).toBeString();
        return { team: { id: "team-1", orgId: org.id } };
      },
    });

    const childRoute = createRoute({
      parent: parentRoute,
      loader: ({ org, team }) => {
        expectTypeOf(org.id).toBeString();
        expectTypeOf(team.orgId).toBeString();
        return { members: [{ name: "Bob" }] as Array<{ name: string }> };
      },
    });

    childRoute.page({
      component: ({ org, team, members }) => {
        expectTypeOf(org.name).toBeString();
        expectTypeOf(team.id).toBeString();
        expectTypeOf(members).toEqualTypeOf<Array<{ name: string }>>();
        return null;
      },
    });
  });

  test("params propagation through nesting", () => {
    const parentRoute = createRoute({
      params: t.Object({ orgId: t.String() }),
      loader: async ({ params }) => ({
        org: { id: params.orgId },
      }),
    });

    const childRoute = createRoute({
      parent: parentRoute,
      params: t.Object({ userId: t.String() }),
      loader: ({ params }) => {
        expectTypeOf(params.orgId).toBeString();
        expectTypeOf(params.userId).toBeString();
        return { profile: { name: "Bob" } };
      },
    });

    childRoute.page({
      component: ({ params, org, profile }) => {
        expectTypeOf(params.orgId).toBeString();
        expectTypeOf(params.userId).toBeString();
        expectTypeOf(org.id).toBeString();
        expectTypeOf(profile.name).toBeString();
        return null;
      },
    });
  });
});

describe("page head", () => {
  test("head receives accumulated data + page loader data", () => {
    const route = createRoute({
      loader: async () => ({ post: { title: "Hello", excerpt: "World" } }),
    });

    route.page({
      loader: async () => ({
        comments: [{ text: "Nice" }],
      }),
      head: ({ post, comments }) => {
        expectTypeOf(post.title).toBeString();
        expectTypeOf(comments).toEqualTypeOf<Array<{ text: string }>>();
        return { meta: [{ title: post.title }] };
      },
      component: () => null,
    });
  });
});

describe("InferProps", () => {
  test("includes loader data + component props", () => {
    const route = createRoute({
      loader: async () => ({ count: 42 }),
    });

    type Props = InferProps<typeof route>;

    expectTypeOf<Props["count"]>().toEqualTypeOf<number>();
    expectTypeOf<Props["params"]>().toEqualTypeOf<{}>();
    expectTypeOf<Props["query"]>().toEqualTypeOf<{}>();
    expectTypeOf<Props["path"]>().toEqualTypeOf<string>();
    // request, cookie, headers, redirect, set are NOT in ComponentProps
    // so they should NOT be accessible in InferProps
  });
});

describe("isElyraRoute", () => {
  test("returns true for a createRoute() result", () => {
    const route = createRoute({ mode: "ssg" });
    expect(isElyraRoute(route)).toBe(true);
  });

  test("returns false for a page object", () => {
    const route = createRoute();
    const page = route.page({ component: () => null });
    expect(isElyraRoute(page)).toBe(false);
  });

  test("returns false for arbitrary objects", () => {
    expect(isElyraRoute(null)).toBe(false);
    expect(isElyraRoute(undefined)).toBe(false);
    expect(isElyraRoute(42)).toBe(false);
    expect(isElyraRoute("hello")).toBe(false);
    expect(isElyraRoute({ __type: "OTHER" })).toBe(false);
    expect(isElyraRoute({})).toBe(false);
  });
});

describe("isElyraPage", () => {
  test("returns true for a route.page() result", () => {
    const route = createRoute();
    const page = route.page({ component: () => null });
    expect(isElyraPage(page)).toBe(true);
  });

  test("returns false for a route object", () => {
    const route = createRoute({ mode: "ssr" });
    expect(isElyraPage(route)).toBe(false);
  });

  test("returns false for arbitrary objects", () => {
    expect(isElyraPage(null)).toBe(false);
    expect(isElyraPage(undefined)).toBe(false);
    expect(isElyraPage({ __type: "ELYRA_ROUTE" })).toBe(false);
    expect(isElyraPage({})).toBe(false);
  });
});

describe("collectRouteChainFromRoute", () => {
  test("single route — chain has one element", () => {
    const route = createRoute({ mode: "ssg" });
    const page = route.page({ component: () => null }) as any;
    const chain = collectRouteChainFromRoute(page);

    expect(chain).toHaveLength(1);
    expect(chain[0]?.__type).toBe("ELYRA_ROUTE");
  });

  test("nested route — chain is [parent, child] top-down", () => {
    const parentRoute = createRoute({
      loader: async () => ({ org: "acme" }),
    });

    const childRoute = createRoute({
      parent: parentRoute,
      loader: async () => ({ team: "dev" }),
    });

    const page = childRoute.page({ component: () => null }) as any;
    const chain = collectRouteChainFromRoute(page);

    expect(chain).toHaveLength(2);
    expect(chain[0]).not.toBe(chain[1]);
    expect(chain[0]?.parent).toBeUndefined();
    expect(chain[1]?.parent).toBe(chain[0]);
  });

  test("triple nesting — chain is [grandparent, parent, child]", () => {
    const grandparent = createRoute({
      loader: async () => ({ level: "grandparent" }),
    });

    const parent = createRoute({
      parent: grandparent,
      loader: async () => ({ level: "parent" }),
    });

    const child = createRoute({
      parent,
      loader: async () => ({ level: "child" }),
    });

    const page = child.page({ component: () => null }) as any;
    const chain = collectRouteChainFromRoute(page);

    expect(chain).toHaveLength(3);
    expect(chain[0]?.parent).toBeUndefined();
    expect(chain[1]?.parent).toBe(chain[0]);
    expect(chain[2]?.parent).toBe(chain[1]);
  });
});
