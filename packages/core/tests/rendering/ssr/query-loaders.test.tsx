import "../../setup/evlog-mock";
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { type Context, Elysia } from "elysia";
import { renderToString } from "react-dom/server";
import { createClient, useQuery, withSync } from "../../../src/client.ts";
import { autoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
import { createMemoryPageCache } from "../../../src/server/cache/page-cache.ts";
import {
  resetPageCacheAdapter,
  setPageCacheAdapter,
} from "../../../src/server/cache/page-cache-state.ts";
import { currentInstance } from "../../../src/server/instance.ts";
import { withDocumentState } from "../../../src/server/render/document.tsx";
import {
  runLoaders,
  runMixedLoaders,
  withRequestLoaderData,
} from "../../../src/server/render/loaders.ts";
import { clearMixedPublicCache } from "../../../src/server/render/mixed-cache.ts";
import { createDeferredRouteFrameStream } from "../../../src/server/render/route-frame-transport.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { queryTag } from "../../../src/shared/sync-query.ts";

test("loader Eden reads hydrate useQuery on the server and register scoped dependencies", async () => {
  __setDevMode(true);
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  let reads = 0;
  const app = new Elysia()
    .use(
      furinSync({
        adapter: sqliteSyncAdapter({ database, namespace: "query-loader" }),
        principal: () => "alice",
      })
    )
    .get(
      "/boards/:boardId/cards",
      {
        sync: { id: "board.cards", scope: ({ params }) => ({ boardId: params.boardId }) },
      },
      () => {
        reads += 1;
        return [{ title: "From the loader" }];
      }
    );
  const api = withSync(treaty(app));
  const route = {
    mode: "ssr",
    pattern: "/board/:boardId",
    page: {
      loader: async () => ({
        initialCards: (await api.boards({ boardId: "alpha" }).cards.get()).data,
      }),
    },
    routeChain: [],
  } as unknown as ResolvedRoute;
  const context = {
    request: new Request("http://localhost/board/alpha"),
    path: "/board/alpha",
    params: { boardId: "alpha" },
    query: {},
    set: { headers: {} },
  } as unknown as Context;
  try {
    const result = await runLoaders(route, context);
    expect(result.type).toBe("data");
    if (result.type !== "data") {
      throw new Error("Loader failed");
    }
    expect(result.syncData.__furinQueries).toHaveLength(1);
    expect(result.syncData.__furinQueries).toMatchObject([
      { bindings: [{ target: ["initialCards"], source: [] }] },
    ]);
    function View() {
      const { data } = useQuery(api.boards({ boardId: "alpha" }).cards.get);
      return <span>{data?.[0]?.title}</span>;
    }
    const html = renderToString(
      withDocumentState(
        <View />,
        { frameworkModules: [], scripts: [], styles: [] } as never,
        undefined,
        result.syncData
      )
    );
    expect(html).toContain("From the loader");
    expect(reads).toBe(1);
    expect(
      autoInvalidateRegistry.pathsForTags([
        queryTag({ id: "board.cards", scope: { boardId: "alpha" } }),
      ])
    ).toContain("/board/alpha");
  } finally {
    autoInvalidateRegistry.unregisterPath("/board/alpha");
    database.close();
  }
});

test("a cached public loader preserves nested GET bindings without another API read", async () => {
  __setDevMode(true);
  let reads = 0;
  const api = createClient(
    new Elysia().get("/boards", ({ set }) => {
      reads += 1;
      set.headers["x-furin-query"] = JSON.stringify({
        id: "board.cards",
        scope: { boardId: "alpha" },
        session: "alice",
      });
      return { cards: [{ title: "Cached" }] };
    })
  );
  const route = {
    mode: "ssr",
    path: "/cached-query-test.tsx",
    pattern: "/cached-query-test",
    routeChain: [],
    page: {
      mode: "isr",
      revalidate: 60,
      loader: async () => {
        const { data } = await api.boards.get();
        return { cards: data?.cards, nested: { cards: data?.cards }, count: data?.cards.length };
      },
    },
  } as unknown as ResolvedRoute;
  const context = {
    request: new Request("http://localhost/cached-query-test"),
    path: "/cached-query-test",
    params: {},
    query: {},
    set: { headers: {} },
  } as unknown as Context;
  try {
    const first = await runMixedLoaders(route, context);
    const cached = await runMixedLoaders(route, context);
    expect(reads).toBe(1);
    expect(first.type).toBe("data");
    expect(cached.type).toBe("data");
    if (cached.type !== "data") {
      throw new Error("Loader failed");
    }
    expect(cached.syncData.__furinQueries).toMatchObject([
      {
        bindings: [
          { source: ["cards"], target: ["cards"] },
          { source: ["cards"], target: ["nested", "cards"] },
        ],
      },
    ]);
    expect(cached.syncData.count).toBe(1);
  } finally {
    clearMixedPublicCache();
    autoInvalidateRegistry.unregisterPath("/cached-query-test");
  }
});

test("a public segment cache does not retain concurrent request GET data", async () => {
  __setDevMode(false);
  const cache = createMemoryPageCache();
  const payloads: string[] = [];
  const instance = currentInstance();
  setPageCacheAdapter(instance, {
    ...cache,
    commit(input) {
      payloads.push(input.entry.payload);
      return cache.commit(input);
    },
  });
  let publicReads = 0;
  let privateReads = 0;
  let privateReady = Promise.withResolvers<void>();
  const api = createClient(
    new Elysia()
      .get("/public", ({ set }) => {
        publicReads += 1;
        set.headers["x-furin-query"] = JSON.stringify({ id: "public", scope: {}, session: "test" });
        return { title: "Public" };
      })
      .get("/private", ({ set }) => {
        privateReads += 1;
        set.headers["x-furin-query"] = JSON.stringify({
          id: "private",
          scope: {},
          session: "test",
        });
        return { title: `Secret ${privateReads}` };
      })
  );
  const route = {
    mode: "ssr",
    path: "/isolated-query-cache.tsx",
    pattern: "/isolated-query-cache",
    tags: [queryTag({ id: "public", scope: {} }), queryTag({ id: "private", scope: {} })],
    requestKeys: ["privateData"],
    routeChain: [
      {
        requestLoader: () => ({
          privateData: api.private.get().then(({ data }) => {
            privateReady.resolve();
            return data;
          }),
        }),
      },
    ],
    page: {
      mode: "isr",
      revalidate: 3600,
      loader: async () => {
        await privateReady.promise;
        return { publicData: (await api.public.get()).data };
      },
    },
  } as unknown as ResolvedRoute;
  const context = {
    request: new Request("http://localhost/isolated-query-cache"),
    path: "/isolated-query-cache",
    params: {},
    query: {},
    set: { headers: {} },
  } as unknown as Context;
  try {
    await runMixedLoaders(route, context);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).not.toContain("Secret");
    privateReady = Promise.withResolvers<void>();
    const second = await runMixedLoaders(route, context);
    if (second.type !== "data") {
      throw new Error("Loader failed");
    }
    expect(await second.deferredPromises?.privateData).toEqual({ title: "Secret 2" });
    expect(JSON.stringify(second.syncData.__furinQueries)).not.toContain("Secret 1");
    expect(publicReads).toBe(1);
    expect(privateReads).toBe(2);
  } finally {
    resetPageCacheAdapter(instance);
    __setDevMode(true);
    clearMixedPublicCache();
    autoInvalidateRegistry.unregisterPath("/isolated-query-cache");
  }
});

test("PPR request GET dependencies and prop bindings stream before unrelated private fields settle", async () => {
  const fast = Promise.withResolvers<void>();
  const slow = Promise.withResolvers<string>();
  const identity = { id: "board.cards", scope: { boardId: "alpha" }, session: "alice" };
  const api = createClient(
    new Elysia().get("/cards", async ({ set }) => {
      await fast.promise;
      set.headers["x-furin-query"] = JSON.stringify(identity);
      return [{ title: "Private" }];
    })
  );
  const route = {
    mode: "isr",
    pattern: "/private-query-test",
    requestKeys: ["privateCards", "alias", "slow"],
    routeChain: [
      {
        requestLoader: () => {
          const read = api.cards.get();
          return {
            privateCards: read.then(({ data }) => data),
            alias: read.then(({ data }) => data),
            slow: slow.promise,
          };
        },
      },
    ],
    page: {},
  } as unknown as ResolvedRoute;
  const context = {
    request: new Request("http://localhost/private-query-test"),
    path: "/private-query-test",
    params: {},
    query: {},
    cookie: {},
    set: { headers: {} },
  } as unknown as Context;
  try {
    const result = await withRequestLoaderData(route, context, {
      type: "data",
      syncData: { catalog: "Public" },
      deferredPromises: undefined,
      headers: {},
    });
    expect(result.syncData).toEqual({ catalog: "Public" });
    const parsed = await parseDeferredNdjson(
      createDeferredRouteFrameStream(result.syncData, result.deferredPromises ?? {}),
      undefined
    );
    fast.resolve();
    expect(await parsed.deferredPromises.privateCards).toEqual([{ title: "Private" }]);
    expect(await parsed.deferredPromises.alias).toEqual([{ title: "Private" }]);
    expect(structuredClone(parsed.syncData.__furinQueries)).toMatchObject([
      {
        identity,
        bindings: expect.arrayContaining([
          { source: [], target: ["privateCards"] },
          { source: [], target: ["alias"] },
        ]),
      },
    ]);
    expect(autoInvalidateRegistry.pathsForTags([queryTag(identity)])).toContain(
      "/private-query-test"
    );
  } finally {
    fast.resolve();
    slow.resolve("ready");
    autoInvalidateRegistry.unregisterPath("/private-query-test");
  }
});

test("request GET sessions preserve independent public query seeds", async () => {
  const publicData = { title: "Public" };
  const publicSeed = {
    url: "https://catalog.example/items",
    data: publicData,
    local: false,
    identity: { id: "catalog", scope: {}, session: "anonymous" },
    bindings: [{ source: [], target: ["catalog"] }],
  };
  const api = createClient(
    new Elysia().get("/private", ({ set }) => {
      set.headers["x-furin-query"] = JSON.stringify({ id: "private", scope: {}, session: "alice" });
      return { title: "Private" };
    })
  );
  const route = {
    pattern: "/query-sessions",
    requestKeys: [],
    page: {},
    routeChain: [
      {
        requestLoader: async () => {
          await api.private.get();
          return {};
        },
      },
    ],
  } as unknown as ResolvedRoute;
  const context = {
    request: new Request("http://localhost/query-sessions"),
    path: "/query-sessions",
    params: {},
    query: {},
    set: { headers: {} },
  } as unknown as Context;
  try {
    const result = await withRequestLoaderData(route, context, {
      type: "data",
      syncData: { catalog: publicData, __furinQueries: [publicSeed] },
      headers: {},
      deferredPromises: undefined,
    });
    expect(result.syncData.__furinQueries).toEqual(expect.arrayContaining([publicSeed]));
  } finally {
    autoInvalidateRegistry.unregisterPath("/query-sessions");
  }
});
