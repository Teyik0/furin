import { describe, expect, test } from "bun:test";
import { t } from "elysia";
import { expectTypeOf } from "expect-type";
import { createRoute, type InferProps } from "../src/client";
import { collectRouteChain, isElysionPage, isElysionRoute } from "../src/types";

describe("createRoute types", () => {
  test("simple route — no loader, no layout", () => {
    const route = createRoute({ mode: "ssg" });

    route.page({
      component: (props) => {
        // @ts-expect-error — params doesn't exist when not defined
        props.params;
        // @ts-expect-error — query doesn't exist when not defined
        props.query;
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

  test("route with loader + layout — layout sees loader data and Component infer props via InferProps", () => {
    const route = createRoute({
      loader: async () => ({
        post: { id: 1, title: "Hello" },
      }),
      layout: (props) => <Component {...props} />,
    });

    function Component({ post, children }: InferProps<typeof route>) {
      expectTypeOf(post).toEqualTypeOf<{ id: number; title: string }>();
      expectTypeOf(children).toEqualTypeOf<React.ReactNode>();
      return null;
    }

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

  test("route with params + query — schemas are inferred and Component infer props via InferProps", () => {
    const route = createRoute({
      params: t.Object({ slug: t.String() }),
      query: t.Object({ page: t.Optional(t.Number()) }),
      loader: async ({ params }) => ({
        post: { id: 1, slug: params.slug },
      }),
    });

    const page = route.page({
      component: (props) => <Component {...props} />,
    });

    function Component({ params, post }: InferProps<typeof page>) {
      expectTypeOf(params.slug).toBeString();
      expectTypeOf(post).toEqualTypeOf<{ id: number; slug: string }>();
      return null;
    }
  });

  test("InferProps on page includes page-level loader data", () => {
    const route = createRoute({
      loader: async () => ({ post: { title: "Hello" } }),
    });

    const page = route.page({
      loader: async () => ({
        comments: [{ text: "Nice" }] as Array<{ text: string }>,
      }),
      component: (props) => <Component {...props} />,
    });

    function Component({ post, comments }: InferProps<typeof page>) {
      expectTypeOf(post).toEqualTypeOf<{ title: string }>();
      expectTypeOf(comments).toEqualTypeOf<Array<{ text: string }>>();
      return null;
    }
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
        // user is flat from parent, not nested in parentData
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

  test("parent → child — layout sees parent + own loader data", () => {
    const parentRoute = createRoute({
      loader: async () => ({
        user: { id: 1, name: "Alice" },
      }),
    });

    createRoute({
      parent: parentRoute,
      loader: async () => ({
        users: [{ id: 1 }] as Array<{ id: number }>,
      }),
      layout: ({ user, users, children }) => {
        expectTypeOf(user.name).toBeString();
        expectTypeOf(users).toEqualTypeOf<Array<{ id: number }>>();
        expectTypeOf(children).toEqualTypeOf<React.ReactNode>();
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

describe("isElysionRoute", () => {
  test("returns true for a createRoute() result", () => {
    const route = createRoute({ mode: "ssg" });
    expect(isElysionRoute(route)).toBe(true);
  });

  test("returns false for a page object", () => {
    const route = createRoute();
    const page = route.page({ component: () => null });
    expect(isElysionRoute(page)).toBe(false);
  });

  test("returns false for arbitrary objects", () => {
    expect(isElysionRoute(null)).toBe(false);
    expect(isElysionRoute(undefined)).toBe(false);
    expect(isElysionRoute(42)).toBe(false);
    expect(isElysionRoute("hello")).toBe(false);
    expect(isElysionRoute({ __type: "OTHER" })).toBe(false);
    expect(isElysionRoute({})).toBe(false);
  });
});

describe("isElysionPage", () => {
  test("returns true for a route.page() result", () => {
    const route = createRoute();
    const page = route.page({ component: () => null });
    expect(isElysionPage(page)).toBe(true);
  });

  test("returns false for a route object", () => {
    const route = createRoute({ mode: "ssr" });
    expect(isElysionPage(route)).toBe(false);
  });

  test("returns false for arbitrary objects", () => {
    expect(isElysionPage(null)).toBe(false);
    expect(isElysionPage(undefined)).toBe(false);
    expect(isElysionPage({ __type: "ELYSION_ROUTE" })).toBe(false);
    expect(isElysionPage({})).toBe(false);
  });
});

describe("collectRouteChain", () => {
  test("single route — chain has one element", () => {
    const route = createRoute({ mode: "ssg" });
    const page = route.page({ component: () => null }) as any;
    const chain = collectRouteChain(page);

    expect(chain).toHaveLength(1);
    expect(chain[0]?.__type).toBe("ELYSION_ROUTE");
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
    const chain = collectRouteChain(page);

    expect(chain).toHaveLength(2);
    // First element is the parent (root), second is the child (leaf)
    expect(chain[0]).not.toBe(chain[1]);
    // Parent has no parent
    expect(chain[0]?.parent).toBeUndefined();
    // Child's parent is the first element
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
    const chain = collectRouteChain(page);

    expect(chain).toHaveLength(3);
    // Verify top-down order
    expect(chain[0]?.parent).toBeUndefined();
    expect(chain[1]?.parent).toBe(chain[0]);
    expect(chain[2]?.parent).toBe(chain[1]);
  });
});
