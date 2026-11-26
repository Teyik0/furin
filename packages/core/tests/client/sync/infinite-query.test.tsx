import "../../setup/global.ts";
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { type Context, Elysia, t } from "elysia";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryStoreContext } from "../../../src/client/query.tsx";
import { QueryStore } from "../../../src/client/query-store.ts";
import { furinSync, useInfiniteQuery } from "../../../src/client.ts";
import { autoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
import { runLoaders } from "../../../src/server/render/loaders.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { furinSync as furinSyncServer } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import type { QuerySeed } from "../../../src/shared/sync-query.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

const PAGE_SIZE = 2;

let root: Root | undefined;
let database: Database;
beforeEach(() => {
  root = undefined;
  database = new Database(":memory:");
  migrateSqliteSync(database);
  installDom();
});
afterEach(async () => {
  await act(() => root?.unmount());
  await uninstallDom();
  database.close();
});

/** A paginated product list; `gate` holds a read until the test releases it. */
function setup(names: string[]) {
  const state = {
    gate: undefined as Promise<void> | undefined,
    names,
    reads: [] as string[],
  };
  const app = new Elysia()
    .use(
      furinSyncServer({
        adapter: sqliteSyncAdapter({ database, namespace: "infinite-query" }),
        principal: () => "alice",
      })
    )
    .get(
      "/products",
      { query: t.Object({ q: t.String(), skip: t.Numeric(), take: t.Numeric() }) },
      async ({ query }) => {
        state.reads.push(`${query.q}@${query.skip}`);
        const rows = state.names
          .filter((name) => name.startsWith(query.q))
          .slice(query.skip, query.skip + query.take);
        await state.gate;
        return rows;
      }
    )
    .post("/products", { body: t.Object({ name: t.String() }) }, ({ body }) => {
      state.names = [body.name, ...state.names];
      return body;
    });
  const api = treaty<typeof app>(window.location.origin, {
    fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  }).use(furinSync);
  const view = { fetchNext: (): void => undefined, frames: [] as string[] };
  function Products({ q }: { q: string }) {
    const result = useInfiniteQuery(
      (index) => api.products.get.live({ query: { q, skip: index * PAGE_SIZE, take: PAGE_SIZE } }),
      { next: (last) => last.length === PAGE_SIZE }
    );
    view.fetchNext = result.fetchNext;
    const frame = `${result.pages.flat().join(",")}|${result.hasNext}`;
    view.frames.push(frame);
    return <span>{frame}</span>;
  }
  const container = document.createElement("div");
  const viewRoot = createRoot(container);
  root = viewRoot;
  // `null` reads Eden's own client store, where plain mutations apply their invalidations.
  const queries = { current: null as QueryStore | null };
  const render = (q: string) =>
    act(async () => {
      viewRoot.render(
        <QueryStoreContext.Provider value={queries.current}>
          <Products q={q} />
        </QueryStoreContext.Provider>
      );
      await Bun.sleep(0);
    });
  const settle = (work?: () => unknown) =>
    act(async () => {
      await work?.();
      await Bun.sleep(0);
    });
  return { api, container, queries, render, settle, state, view };
}

test("fetchNext appends the next page and hasNext follows next(last)", async () => {
  const { container, render, settle, view } = setup(["a1", "a2", "a3"]);
  await render("a");
  expect(container.textContent).toBe("a1,a2|true");
  await settle(() => view.fetchNext());
  expect(container.textContent).toBe("a1,a2,a3|false");
});

test("a mutation refetches every loaded page and keeps the page count", async () => {
  const { api, container, render, settle, state, view } = setup(["a1", "a2", "a3", "a4"]);
  await render("a");
  await settle(() => view.fetchNext());
  expect(container.textContent).toBe("a1,a2,a3,a4|true");
  state.reads = [];
  await settle(() => api.products.post({ name: "a0" }));
  expect(container.textContent).toBe("a0,a1,a2,a3|true");
  expect(state.reads.sort()).toEqual(["a@0", "a@2"]);
});

test("changing the query restarts at page 1 and drops the old pages", async () => {
  const { container, render, settle, view } = setup(["a1", "a2", "a3", "b1", "b2", "b3"]);
  await render("a");
  await settle(() => view.fetchNext());
  expect(container.textContent).toBe("a1,a2,a3|false");
  await render("b");
  expect(container.textContent).toBe("b1,b2|true");
  await render("a");
  expect(container.textContent).toBe("a1,a2|true");
});

test("a page resolving after the query changed never shows up", async () => {
  const { container, render, settle, state, view } = setup(["a1", "a2", "a3", "b1", "b2"]);
  await render("a");
  const gate = Promise.withResolvers<void>();
  state.gate = gate.promise;
  await settle(() => view.fetchNext());
  state.gate = undefined;
  await render("b");
  await settle(() => gate.resolve());
  expect(container.textContent).toBe("b1,b2|true");
  expect(view.frames.filter((frame) => frame.includes("a3"))).toEqual([]);
});

test("a page resolving after an invalidation never shows its stale rows", async () => {
  const { api, container, render, settle, state, view } = setup(["a1", "a2", "a3", "a4"]);
  await render("a");
  const gate = Promise.withResolvers<void>();
  state.gate = gate.promise;
  await settle(() => view.fetchNext());
  state.gate = undefined;
  await settle(() => api.products.post({ name: "a0" }));
  await settle(() => gate.resolve());
  expect(container.textContent).toBe("a0,a1,a2,a3|true");
  expect(state.reads.filter((read) => read === "a@2")).toHaveLength(2);
  // The in-flight page 2 read "a3,a4" before the insert: it must be dropped, not rendered.
  expect(view.frames.filter((frame) => frame.includes("a4"))).toEqual([]);
});

test("page 1 seeded by an SSR loader does not refetch on mount", async () => {
  const { api, container, queries, render, state } = setup(["a1", "a2", "a3"]);
  const route = {
    mode: "ssr",
    pattern: "/infinite-seed-test",
    page: {
      loader: async () => ({
        first: (await api.products.get.live({ query: { q: "a", skip: 0, take: PAGE_SIZE } })).data,
      }),
    },
    routeChain: [],
  } as unknown as ResolvedRoute;
  const context = {
    request: new Request("http://localhost/infinite-seed-test"),
    path: "/infinite-seed-test",
    params: {},
    query: {},
    set: { headers: {} },
  } as unknown as Context;
  try {
    const loaded = await runLoaders(route, context);
    if (loaded.type !== "data") {
      throw new Error("Loader failed");
    }
    queries.current = new QueryStore(window.location.origin);
    queries.current.hydrate(loaded.syncData.__furinQueries as QuerySeed[], window.location.origin);
    state.reads = [];
    await render("a");
    expect(container.textContent).toBe("a1,a2|true");
    expect(state.reads).toEqual([]);
  } finally {
    autoInvalidateRegistry.unregisterPath("/infinite-seed-test");
  }
});

test("concurrent fetchNext calls load the next page once", async () => {
  const { container, render, settle, state, view } = setup(["a1", "a2", "a3", "a4", "a5"]);
  await render("a");
  state.reads = [];
  await settle(() => {
    view.fetchNext();
    view.fetchNext();
  });
  expect(container.textContent).toBe("a1,a2,a3,a4|true");
  expect(state.reads).toEqual(["a@2"]);
});
