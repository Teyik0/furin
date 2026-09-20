import { describe, expect, test } from "bun:test";
import { t } from "elysia";
import { defineRoute } from "../../src/furin.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../src/server/router/defined-route.ts";

describe("defineRoute renderer adapter", () => {
  test("forwards the runtime render context without copying it", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    let receivedProps: unknown;
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .page((props) => {
        receivedProps = props;
        return null;
      });
    const page = adaptDefinedPage(route, parent);
    const renderContext = { params: {}, path: "/boards", query: {} };

    page.component(renderContext);

    expect(receivedProps).toBe(renderContext);
    await Promise.resolve();
  });

  test("forwards the runtime layout context without copying it", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    let receivedProps: unknown;
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .layout((props) => {
        receivedProps = props;
        return null;
      });
    const layout = adaptDefinedLayout(route, parent);
    const renderContext = { children: "Content", params: {}, path: "/boards", query: {} };

    layout.layout?.(renderContext);

    expect(receivedProps).toBe(renderContext);
    await Promise.resolve();
  });

  test("forwards the runtime head context without copying it", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    let receivedContext: unknown;
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .loader(() => ({}))
      .head((context) => {
        receivedContext = context;
        return {};
      })
      .page(() => null);
    const page = adaptDefinedPage(route, parent);
    const headContext = { params: {}, path: "/boards", query: {} };

    page.head?.(headContext);

    expect(receivedContext).toBe(headContext);
    await Promise.resolve();
  });

  test("passes an empty render path through the runtime context", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .loader(() => ({}))
      .head(({ path }) => ({ meta: [{ title: path }] }))
      .page(({ path }) => path);
    const page = adaptDefinedPage(route, parent);

    expect(page.component({ params: {}, path: "", query: {} })).toBe("");
    expect(page.head?.({ params: {}, path: "", query: {} })).toEqual({
      meta: [{ title: "" }],
    });
    await Promise.resolve();
  });

  test("maps loader, head and structured component props to the runtime contract", async () => {
    const root = { __type: "FURIN_ROUTE" as const };
    const layout = defineRoute()
      .config({ layout: root, mode: "ssr" })
      .loader(() => ({ organization: "Furin" }))
      .layout(({ children, organization }) => `${organization}:${children}`);
    const runtimeLayout = adaptDefinedLayout(layout, root);
    const route = defineRoute()
      .config({ layout: root, mode: "isr", params: t.Object({ id: t.Number() }), revalidate: 60 })
      .loader(({ params }) => ({ board: `Board ${params.id}` }))
      .head(({ board }) => ({ meta: [{ title: board }] }))
      .page(({ board, params }) => `${board}:${params.id}`);
    const page = adaptDefinedPage(route, runtimeLayout);

    expect(await page.loader?.({ params: { id: 42 }, query: {} })).toEqual({
      board: "Board 42",
    });
    expect(page.component({ board: "Board 42", params: { id: 42 }, query: {} })).toBe(
      "Board 42:42"
    );
    expect(page.head?.({ board: "Board 42", params: { id: 42 }, query: {} })).toEqual({
      meta: [{ title: "Board 42" }],
    });
    expect(page.mode).toBe("isr");
    expect(page._route.parent).toBe(runtimeLayout);
    expect(runtimeLayout.parent).toBe(root);
  });

  test("keeps static params on layout and page runtime entries", async () => {
    const root = { __type: "FURIN_ROUTE" as const };
    const layoutRoute = defineRoute()
      .config({ layout: root, mode: "ssg", params: t.Object({ category: t.String() }) })
      .staticParams(() => [{ category: "guides" }])
      .layout(({ children }) => children);
    const runtimeLayout = adaptDefinedLayout(layoutRoute, root);
    const pageRoute = defineRoute()
      .config({
        layout: layoutRoute,
        mode: "ssg",
        params: t.Object({ category: t.String(), slug: t.String() }),
      })
      .staticParams(({ params }) => [{ ...params, slug: "routing" }])
      .page(() => null);
    const page = adaptDefinedPage(pageRoute, runtimeLayout);

    expect(await runtimeLayout.staticParams?.({ params: {} })).toEqual([{ category: "guides" }]);
    expect(await page.staticParams?.({ params: { category: "guides" } })).toEqual([
      { category: "guides", slug: "routing" },
    ]);
  });

  test("keeps requestLoader data outside public loader data", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ public: "catalog" }))
      .page(
        ({ public: catalog, requestData: privateData }) =>
          `${String(catalog)}:${String(privateData)}`
      );
    const page = adaptDefinedPage(route, parent);
    const requestPromise = Promise.resolve({ user: "alice" });

    expect(page._route.requestLoader).toBeFunction();
    expect(page.component({ public: "catalog", requestData: requestPromise })).toBe(
      `catalog:${String(requestPromise)}`
    );
    expect(await requestPromise).toEqual({ user: "alice" });
  });
});
