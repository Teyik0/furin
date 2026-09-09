import { describe, expect, test } from "bun:test";
import { t } from "elysia";
import { defineRoute } from "../../src/furin.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../src/server/router/defined-route.ts";

describe("defineRoute renderer adapter", () => {
  test("defaults a missing render path to an empty string", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .loader(() => ({}))
      .head(({ path }) => ({ meta: [{ title: path }] }))
      .page(({ path }) => path);
    const page = adaptDefinedPage(route, parent);

    expect(page.component({})).toBe("");
    expect(page.head?.({})).toEqual({ meta: [{ title: "" }] });
    await Promise.resolve();
  });

  test("maps loader, head and structured component props to the runtime contract", async () => {
    const root = { __type: "FURIN_ROUTE" as const };
    const layout = defineRoute()
      .config({ layout: root, mode: "ssr" })
      .loader(() => ({ organization: "Furin" }))
      .layout(({ children, data }) => `${data.organization}:${children}`);
    const runtimeLayout = adaptDefinedLayout(layout, root);
    const route = defineRoute()
      .config({ layout: root, mode: "isr", params: t.Object({ id: t.Number() }), revalidate: 60 })
      .loader(({ params }) => ({ board: `Board ${params.id}` }))
      .head(({ data }) => ({ meta: [{ title: data.board }] }))
      .page(({ data, params }) => `${data.board}:${params.id}`);
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

  test("keeps requestLoader data outside public loader data", async () => {
    const parent = { __type: "FURIN_ROUTE" as const };
    const route = defineRoute()
      .config({ layout: parent, mode: "ssr" })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ public: "catalog" }))
      .page(
        ({ data, requestData: privateData }) => `${String(data.public)}:${String(privateData)}`
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
