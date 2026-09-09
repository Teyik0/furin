import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { defineRootRoute, defineRoute } from "../../src/furin.ts";

const rootRoute = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);

const route = defineRoute()
  .config({
    layout: rootRoute,
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
  .head(({ data, params }) => {
    const board: string = data.board;
    const id: number = params.id;
    return { meta: [{ title: `${board} ${id}` }] };
  })
  .page(({ data, params, query }) => {
    const board: string = data.board;
    const id: number = params.id;
    const tab: string | undefined = query.tab;
    return `${board}:${id}:${tab ?? "none"}`;
  });

const app = new Elysia().use(new Elysia({ prefix: "/boards/:id" }).use(route.elysia));

const queryRoute = defineRoute()
  .config({ layout: rootRoute, mode: "ssr", query: t.Object({ page: t.Number() }) })
  .loader(({ query }) => {
    const page: number = query.page;
    return { page };
  })
  .page(({ data, query }) => `${data.page}:${query.page}`);

const queryApp = new Elysia().use(new Elysia({ prefix: "/search" }).use(queryRoute.elysia));

describe("defineRoute", () => {
  test("delegates matched native routes to the Furin renderer when mounted", async () => {
    let loaderCalls = 0;
    const renderedRoute = defineRoute()
      .config({ layout: rootRoute, mode: "ssr" })
      .loader(() => {
        loaderCalls += 1;
        return { title: "loader" };
      })
      .page(({ data }) => data.title);
    const renderedApp = new Elysia()
      .decorate("$furinRender", () => new Response("<main>SSR</main>"))
      .use(renderedRoute.elysia);

    const response = await renderedApp.handle(new Request("http://localhost/"));

    expect(await response.text()).toBe("<main>SSR</main>");
    expect(loaderCalls).toBe(0);
  });

  test("builds a schema-validated Elysia route with Furin metadata", async () => {
    const response = await app.handle(new Request("http://localhost/boards/42?tab=activity"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ board: "Board 42", tab: "activity" });
    expect(route.mode).toBe("isr");
    expect(route.revalidate).toBe(60);
    expect(route.tags).toEqual(["boards"]);
    expect(
      route.head?.({
        data: { board: "Board 42", tab: "activity" },
        params: { id: 42 },
        path: "/boards/42",
        query: { tab: "activity" },
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
    expect(await response.json()).toEqual({ page: 2 });
    expect(invalid.status).toBe(422);
  });

  test("keeps static params on an SSG page terminal", async () => {
    const staticRoute = defineRoute()
      .config({
        layout: rootRoute,
        mode: "ssg",
        params: t.Object({ slug: t.String() }),
        staticParams: () => [{ slug: "hello-world" }],
      })
      .page(({ params }) => params.slug);

    expect(await staticRoute.staticParams?.()).toEqual([{ slug: "hello-world" }]);
  });

  test("types request-specific data through the requestLoader stage", async () => {
    const privateRoute = defineRoute()
      .config({ layout: rootRoute, mode: "ssr", query: t.Object({ locale: t.String() }) })
      .requestLoader(({ cookies, query }) => ({
        locale: query.locale,
        user: cookies.get("session"),
      }))
      .loader(() => ({ catalog: "Shoes" }))
      .page(({ data, requestData }) => {
        const catalog: string = data.catalog;
        const privateData: Promise<{ locale: string; user: unknown }> = requestData;
        return `${catalog}:${String(privateData)}`;
      });

    if (typeof privateRoute.requestLoader !== "function") {
      throw new Error("requestLoader was not retained on the route terminal");
    }
    await Promise.resolve();
  });

  test("types parent loader data without retaining the parent at runtime", async () => {
    const parent = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => ({ organization: "Furin" }))
      .layout(({ children }) => children);
    const child = defineRoute()
      .config({
        layout: parent,
        mode: "ssr",
        params: t.Object({ boardId: t.Number() }),
      })
      .loader(async ({ organization, params }) => {
        const organizationPromise: Promise<string> = organization;
        const name: string = await organization;
        const boardId: number = params.boardId;
        return { board: `${name}:${boardId}:${await organizationPromise}` };
      })
      .head(({ data }) => {
        const name: string = data.organization;
        const board: string = data.board;
        return { meta: [{ title: `${name}:${board}` }] };
      })
      .page(({ data }) => {
        const name: string = data.organization;
        const board: string = data.board;
        return `${name}:${board}`;
      });

    expect("parent" in child).toBe(false);
    await Promise.resolve();
  });

  test("accumulates ancestor loader data through nested layouts", async () => {
    const rootLayout = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => ({ account: "acme" }))
      .layout(({ children }) => children);
    const organizationLayout = defineRoute()
      .config({ layout: rootLayout, mode: "ssr" })
      .loader(async ({ account }) => ({ organization: `${await account}:furin` }))
      .layout(({ data, children }) => {
        const account: string = data.account;
        const organization: string = data.organization;
        return `${account}:${organization}:${children}`;
      });
    const child = defineRoute()
      .config({
        layout: organizationLayout,
        mode: "ssr",
        query: t.Object({ page: t.Number() }),
      })
      .loader(async ({ account, organization, query }) => ({
        label: `${await (account satisfies Promise<string>)}:${await (organization satisfies Promise<string>)}:${query.page}`,
      }))
      .page(({ data, query }) => {
        const account: string = data.account;
        const organization: string = data.organization;
        const label: string = data.label;
        const page: number = query.page;
        return `${account}:${organization}:${label}:${page}`;
      });
    const nestedApp = new Elysia().use(
      rootLayout.elysia.use(organizationLayout.elysia.use(child.elysia))
    );

    const response = await nestedApp.handle(new Request("http://localhost/?page=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ label: "acme:acme:furin:1" });
    expect("parent" in child).toBe(false);
  });

  test("passes dynamic child params to a layout loader", async () => {
    const layout = defineRootRoute()
      .config({ mode: "ssr", params: t.Object({ organizationId: t.Number() }) })
      .loader(({ params }) => ({ organizationId: params.organizationId }))
      .layout(({ children }) => children);
    const child = defineRoute()
      .config({
        layout,
        mode: "ssr",
        params: t.Object({ boardId: t.Number(), organizationId: t.Number() }),
      })
      .loader((context) => ({
        boardId: context.params.boardId,
        organizationId: (context as typeof context & { organizationId: number }).organizationId,
      }))
      .page(({ data }) => `${data.organizationId}:${data.boardId}`);
    const nestedApp = new Elysia().use(
      new Elysia({ prefix: "/:organizationId" }).use(
        layout.elysia.use(new Elysia({ prefix: "/boards/:boardId" }).use(child.elysia))
      )
    );

    const response = await nestedApp.handle(new Request("http://localhost/12/boards/42"));
    const invalid = await nestedApp.handle(new Request("http://localhost/nope/boards/42"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ boardId: 42, organizationId: 12 });
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
    const child = defineRoute()
      .config({ layout, mode: "ssr" })
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
