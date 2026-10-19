import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { defineRootRoute, defineRoute } from "../../src/furin.ts";

// Parents of the inheritance tests below, wired through FileRoutes as
// furin-env.d.ts would wire them from the pages tree.
const publicRequestParent = defineRootRoute()
  .config({ mode: "ssg" })
  .requestLoader(() => ({ session: "private" }))
  .loader(() => ({ organization: "public" }))
  .layout(({ children }) => children);
const privateRequestParent = defineRootRoute()
  .config({ mode: "ssr" })
  .requestLoader(() => ({ session: "private" }))
  .loader(() => ({ organization: "public" }))
  .layout(({ children }) => children);
const adminRequestParent = defineRootRoute()
  .config({ mode: "ssg" })
  .requestLoader(() => ({ adminUser: { id: "admin-1" } }))
  .layout(({ children }) => children);
const organizationParent = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(() => ({ organization: "Furin" }))
  .layout(({ children }) => children);
const slugsParent = defineRootRoute()
  .config({ mode: "ssg", params: t.Object({ category: t.String() }) })
  .loader(() => ({ slugs: ["hello-world"] }))
  .layout(({ children }) => children);
const accountRoot = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(() => ({ account: "acme" }))
  .layout(({ children }) => children);
const createOrganizationLayout = () =>
  defineRoute("/define-route/organization/_route")
    .config({ mode: "ssr" })
    .loader(async ({ account }) => ({ organization: `${await account}:furin` }))
    .layout(({ account, children, organization }) => {
      const accountName: string = account;
      const organizationName: string = organization;
      return `${accountName}:${organizationName}:${children}`;
    });
declare const organizationLayout: ReturnType<typeof createOrganizationLayout>;

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/define-route/[category]/[slug]": {
      kind: "page";
      parent: typeof slugsParent;
      pathParams: NonNullable<unknown>;
    };
    "/define-route/admin-child": {
      kind: "page";
      parent: typeof adminRequestParent;
      pathParams: NonNullable<unknown>;
    };
    "/define-route/board": {
      kind: "page";
      parent: typeof organizationParent;
      pathParams: NonNullable<unknown>;
    };
    "/define-route/organization/_route": {
      kind: "layout";
      parent: typeof accountRoot;
      pathParams: NonNullable<unknown>;
    };
    "/define-route/organization/child": {
      kind: "page";
      parent: typeof organizationLayout;
      pathParams: NonNullable<unknown>;
    };
    "/define-route/private-child": {
      kind: "page";
      parent: typeof privateRequestParent;
      pathParams: NonNullable<unknown>;
    };
    "/define-route/public-child": {
      kind: "page";
      parent: typeof publicRequestParent;
      pathParams: NonNullable<unknown>;
    };
  }
}

const route = defineRoute("/")
  .config({
    mode: "isr",
    params: t.Object({ id: t.Number() }),
    query: t.Object({ tab: t.Optional(t.String()) }),
    revalidate: 60,
    tags: ["boards"],
  })
  .loader(async ({ params, query }) => ({
    board: `Board ${params.id}`,
    tab: query.tab,
  }))
  .head(({ board, params }) => {
    const boardTitle: string = board;
    const id: number = params.id;
    return { meta: [{ title: `${boardTitle} ${id}` }] };
  })
  .page((props) => {
    const { board, params, query } = props;
    const boardTitle: string = board;
    const id: number = params.id;
    const tab: string | undefined = query.tab;
    return `${boardTitle}:${id}:${tab ?? "none"}`;
  });

const echoRenderer = (context: { params: unknown; query: unknown }) =>
  Response.json({ params: context.params, query: context.query });

const app = new Elysia()
  .decorate("$furinRender", echoRenderer)
  .use(new Elysia({ prefix: "/boards/:id" }).use(route.elysia));

const queryRoute = defineRoute("/query")
  .config({ mode: "ssr", query: t.Object({ page: t.Number() }) })
  .loader(({ query }) => {
    const page: number = query.page;
    return { page };
  })
  .page(({ page, query }) => `${page}:${query.page}`);

const queryApp = new Elysia()
  .decorate("$furinRender", echoRenderer)
  .use(new Elysia({ prefix: "/search" }).use(queryRoute.elysia));

describe("defineRoute", () => {
  test("delegates matched native routes to the Furin renderer when mounted", async () => {
    let loaderCalls = 0;
    const renderedRoute = defineRoute("/rendered")
      .config({ mode: "ssr" })
      .loader(() => {
        loaderCalls += 1;
        return { title: "loader" };
      })
      .page(({ title }) => title);
    const renderedApp = new Elysia()
      .decorate("$furinRender", () => new Response("<main>SSR</main>"))
      .use(renderedRoute.elysia);

    const response = await renderedApp.handle(new Request("http://localhost/"));

    expect(await response.text()).toBe("<main>SSR</main>");
    expect(loaderCalls).toBe(0);
  });

  test("refuses to serve a page when mounted outside furin()", async () => {
    let loaderCalls = 0;
    const page = defineRoute("/")
      .config({ mode: "ssr" })
      .loader(() => {
        loaderCalls += 1;
        return { secret: "loader data" };
      })
      .page(({ secret }) => secret);

    const response = await new Elysia().use(page.elysia).handle(new Request("http://localhost/"));

    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).toContain("must be mounted through furin()");
    expect(body).not.toContain("loader data");
    expect(loaderCalls).toBe(0);
  });

  test("does not run layout loaders when mounted outside furin()", async () => {
    let loaderCalls = 0;
    const layout = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => {
        loaderCalls += 1;
        return { secret: "layout data" };
      })
      .layout(({ children }) => children);
    const child = defineRoute("/child")
      .config({ mode: "ssr" })
      .page(() => null);

    const response = await new Elysia()
      .use(layout.elysia.use(child.elysia))
      .handle(new Request("http://localhost/"));

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("layout data");
    expect(loaderCalls).toBe(0);
  });

  test("builds a schema-validated Elysia route with Furin metadata", async () => {
    const response = await app.handle(new Request("http://localhost/boards/42?tab=activity"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ params: { id: 42 }, query: { tab: "activity" } });
    expect(route.mode).toBe("isr");
    expect(route.revalidate).toBe(60);
    expect(route.tags).toEqual(["boards"]);
    expect(
      route.head?.({
        board: "Board 42",
        params: { id: 42 },
        path: "/boards/42",
        query: { tab: "activity" },
        tab: "activity",
      })
    ).toEqual({ meta: [{ title: "Board 42 42" }] });
  });

  test("keeps Elysia validation active after composition", async () => {
    const response = await app.handle(new Request("http://localhost/boards/not-a-number"));

    expect(response.status).toBe(422);
  });

  test("supports a query schema without a params schema", async () => {
    const response = await queryApp.handle(new Request("http://localhost/search?page=2"));
    const invalid = await queryApp.handle(new Request("http://localhost/search?page=nope"));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ query: { page: 2 } });
    expect(invalid.status).toBe(422);
  });

  test("keeps static params on an SSG page terminal", async () => {
    const staticRoute = defineRoute("/static")
      .config({
        mode: "ssg",
        params: t.Object({ slug: t.String() }),
      })
      .staticParams(() => [{ slug: "hello-world" }])
      .page(({ params }) => params.slug);

    expect(await staticRoute.staticParams?.({ params: {} })).toEqual([{ slug: "hello-world" }]);
  });

  test("rejects static params passed inside config at runtime", async () => {
    const config = defineRoute("/config").config as unknown as (options: object) => unknown;
    let thrown: unknown;

    try {
      config({ mode: "ssg", staticParams: () => [{ slug: "legacy" }] });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toContain("staticParams() must be chained after config()");
    await Promise.resolve();
  });

  test("rejects a page-owned requestLoader in SSR at runtime", () => {
    const chain = defineRoute("/chain")
      .config({ mode: "ssr" })
      .requestLoader(() => ({ user: "private" }));
    const untypedChain = chain as unknown as { page: (component: () => null) => unknown };

    expect(() => untypedChain.page(() => null)).toThrow(
      "[furin] SSR pages cannot declare requestLoader(); use loader() and defer()."
    );
  });

  test("types request-specific data through the requestLoader stage", async () => {
    const privateRoute = defineRoute("/private")
      .config({
        mode: "isr",
        query: t.Object({ locale: t.String() }),
        revalidate: 60,
      })
      .requestLoader(({ cookies, query }) => ({
        locale: query.locale,
        user: cookies.get("session"),
      }))
      .loader(() => ({ catalog: "Shoes" }))
      .page((props) => {
        const { catalog, locale, user } = props;
        const publicCatalog: string = catalog;
        const privateLocale: Promise<string> = locale;
        const privateUser: Promise<unknown> = user;
        // @ts-expect-error no grouped requestData prop is added implicitly.
        expect(props.requestData).toBeUndefined();
        return `${publicCatalog}:${String(privateLocale)}:${String(privateUser)}`;
      });

    if (typeof privateRoute.requestLoader !== "function") {
      throw new Error("requestLoader was not retained on the route terminal");
    }
    await Promise.resolve();
  });

  test("does not expose parent request fields to a public child loader", () => {
    const child = defineRoute("/define-route/public-child")
      .config({ mode: "isr", revalidate: 60 })
      .loader((context) => {
        const organization: Promise<string> = context.organization;
        // @ts-expect-error Request loader data must not enter a cached loader.
        expect(context.session).toBeUndefined();
        return { title: organization };
      })
      .page(({ title }) => String(title));

    expect(child.loader).toBeFunction();
  });

  test("types inherited private fields in a child loader and page", () => {
    const child = defineRoute("/define-route/private-child")
      .config({ mode: "ssr" })
      .loader(async (context) => {
        const privateSession: Promise<string> = context.session;
        return { inheritedSession: await privateSession, title: "Child" };
      })
      .page(({ inheritedSession, session, organization, title }) => {
        const privateSession: Promise<string> = session;
        const loaderSession: string = inheritedSession;
        const publicOrganization: string = organization;
        return `${title}:${publicOrganization}:${String(privateSession)}:${String(loaderSession)}`;
      });
    expect(child.page).toBeFunction();
  });

  test("types an SSG layout request field in an SSR child loader", () => {
    const child = defineRoute("/define-route/admin-child")
      .config({ mode: "ssr" })
      .loader(async ({ adminUser }) => {
        const user: { id: string } = await adminUser;
        return { id: user.id };
      })
      .page(({ id }) => id);

    expect(child.loader).toBeFunction();
  });

  test("defines head after requestLoader without a public loader", () => {
    const page = defineRoute("/")
      .config({ mode: "ssg" })
      .requestLoader(() => ({ result: { count: 25 } }))
      .head(({ path }) => ({ meta: [{ title: path }] }))
      .page(({ result }) => {
        const reservations: Promise<{ count: number }> = result;
        return String(reservations);
      });

    expect(page.head?.({ params: {}, path: "/reservations", query: {} })).toEqual({
      meta: [{ title: "/reservations" }],
    });
    expect("loader" in page).toBe(false);
  });

  test("defines head on a query route without a public loader", () => {
    const page = defineRoute("/")
      .config({
        mode: "isr",
        query: t.Object({ status: t.String() }),
        revalidate: 60,
      })
      .requestLoader(() => ({ result: "private" }))
      .head(({ query }) => ({ meta: [{ title: query.status }] }))
      .page(({ result }) => String(result));

    expect(
      page.head?.({ params: {}, path: "/reservations", query: { status: "pending" } })
    ).toEqual({ meta: [{ title: "pending" }] });
    expect("loader" in page).toBe(false);
  });

  test("defines head on a params route without a public loader", () => {
    const page = defineRoute("/")
      .config({
        mode: "ssg",
        params: t.Object({ id: t.String() }),
      })
      .requestLoader(() => ({ result: "private" }))
      .head(({ params }) => ({ meta: [{ title: params.id }] }))
      .page(({ result }) => String(result));

    expect(page.head?.({ params: { id: "123" }, path: "/reservations/123", query: {} })).toEqual({
      meta: [{ title: "123" }],
    });
    expect("loader" in page).toBe(false);
  });

  test("types parent loader data without retaining the parent at runtime", async () => {
    const child = defineRoute("/define-route/board")
      .config({
        mode: "ssr",
        params: t.Object({ boardId: t.Number() }),
      })
      .loader(async ({ organization, params }) => {
        const organizationPromise: Promise<string> = organization;
        const name: string = await organization;
        const boardId: number = params.boardId;
        return { board: `${name}:${boardId}:${await organizationPromise}` };
      })
      .head(({ board, organization }) => {
        const name: string = organization;
        const boardName: string = board;
        return { meta: [{ title: `${name}:${boardName}` }] };
      })
      .page(({ board, organization }) => {
        const name: string = organization;
        const boardName: string = board;
        return `${name}:${boardName}`;
      });

    expect("parent" in child).toBe(false);
    await Promise.resolve();
  });

  test("types parent loader data in static params", async () => {
    const child = defineRoute("/define-route/[category]/[slug]")
      .config({
        mode: "ssg",
        params: t.Object({ category: t.String(), slug: t.String() }),
      })
      .staticParams(async ({ params, slugs }) => {
        const inheritedCategory: string | undefined = params.category;
        const parentSlugs: Promise<string[]> = slugs;
        return (await parentSlugs).map((slug) => ({
          slug: `${inheritedCategory ?? "all"}-${slug}`,
        }));
      })
      .page(({ params }) => params.slug);

    expect(typeof child.staticParams).toBe("function");
    await Promise.resolve();
  });

  test("accumulates ancestor loader data through nested layouts", async () => {
    expect(createOrganizationLayout().layout).toBeFunction();
    const child = defineRoute("/define-route/organization/child")
      .config({
        mode: "ssr",
        query: t.Object({ page: t.Number() }),
      })
      .loader(async ({ account, organization, query }) => ({
        label: `${await (account satisfies Promise<string>)}:${await (organization satisfies Promise<string>)}:${query.page}`,
      }))
      .page(({ account, label, organization, query }) => {
        const accountName: string = account;
        const organizationName: string = organization;
        const pageLabel: string = label;
        const page: number = query.page;
        return `${accountName}:${organizationName}:${pageLabel}:${page}`;
      });
    expect("parent" in child).toBe(false);
    await Promise.resolve();
  });

  test("validates dynamic layout params before the renderer", async () => {
    const layout = defineRootRoute()
      .config({ mode: "ssr", params: t.Object({ organizationId: t.Number() }) })
      .loader(({ params }) => ({ organizationId: params.organizationId }))
      .layout(({ children }) => children);
    const child = defineRoute("/child")
      .config({
        mode: "ssr",
        params: t.Object({ boardId: t.Number(), organizationId: t.Number() }),
      })
      .loader((context) => ({
        boardId: context.params.boardId,
        organizationId: (context as typeof context & { organizationId: number }).organizationId,
      }))
      .page(({ boardId, organizationId }) => `${organizationId}:${boardId}`);
    const nestedApp = new Elysia()
      .decorate("$furinRender", echoRenderer)
      .use(
        new Elysia({ prefix: "/:organizationId" }).use(
          layout.elysia.use(new Elysia({ prefix: "/boards/:boardId" }).use(child.elysia))
        )
      );

    const response = await nestedApp.handle(new Request("http://localhost/12/boards/42"));
    const invalid = await nestedApp.handle(new Request("http://localhost/nope/boards/42"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      params: { boardId: 42, organizationId: 12 },
      query: {},
    });
    expect(invalid.status).toBe(422);
  });

  test("passes normalized layout params and query to the renderer", async () => {
    const layout = defineRootRoute()
      .config({
        mode: "ssr",
        params: t.Object({ organizationId: t.Number() }),
        query: t.Object({ page: t.Optional(t.Number({ default: 7 })) }),
      })
      .layout(({ children }) => children);
    const child = defineRoute("/child")
      .config({ mode: "ssr" })
      .page(() => null);
    const nestedApp = new Elysia()
      .decorate("$furinRender", (context: { params: unknown; query: unknown }) =>
        Response.json({ params: context.params, query: context.query })
      )
      .use(new Elysia({ prefix: "/:organizationId" }).use(layout.elysia.use(child.elysia)));

    const response = await nestedApp.handle(new Request("http://localhost/42"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      params: { organizationId: 42 },
      query: { page: 7 },
    });
  });
});
