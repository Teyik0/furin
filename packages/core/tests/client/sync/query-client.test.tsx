import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { type Context, Elysia, t } from "elysia";
import { act } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { QueryStoreContext } from "../../../src/client/query.tsx";
import { QueryStore } from "../../../src/client/query-store.ts";
import { createClient, useQuery } from "../../../src/client.ts";
import { autoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
import { withDocumentState } from "../../../src/server/render/document.tsx";
import { runLoaders } from "../../../src/server/render/loaders.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import type { QuerySeed } from "../../../src/shared/sync-query.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

let root: Root | undefined;
beforeEach(() => {
  root = undefined;
  installDom();
});
afterEach(async () => {
  await act(() => root?.unmount());
  await uninstallDom();
});

test.each([
  { consumer: "optionless", token: undefined, expected: "Public" },
  { consumer: "different credentials", token: "Bob", expected: "Bob" },
  { consumer: "same credentials", token: "Private Alice", expected: "Private Alice" },
])(
  "credential-scoped SSR snapshots do not alias a $consumer browser query",
  async ({ token, expected }) => {
    const app = new Elysia().get("/me", ({ headers, set }) => {
      const name = headers.authorization ?? "Public";
      set.headers["x-furin-query"] = JSON.stringify({ id: "me", scope: {}, session: name });
      return { name };
    });
    const serverApi = createClient<typeof app>("http://ssr.internal", {
      fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    });
    const route = {
      mode: "ssr",
      pattern: "/credential-seed-test",
      page: {
        loader: async () => ({
          profile: (await serverApi.me.get({ headers: { authorization: "Private Alice" } })).data,
        }),
      },
      routeChain: [],
    } as unknown as ResolvedRoute;
    const context = {
      request: new Request("http://localhost/credential-seed-test"),
      path: "/credential-seed-test",
      params: {},
      query: {},
      set: { headers: {} },
    } as unknown as Context;
    const loaded = await runLoaders(route, context);
    if (loaded.type !== "data") {
      throw new Error("Loader failed");
    }
    expect(loaded.syncData.profile).toEqual({ name: "Private Alice" });
    expect(loaded.syncData.__furinQueries).toMatchObject([
      { data: { name: "Private Alice" }, bindings: [{ source: [], target: ["profile"] }] },
    ]);
    const options = token === undefined ? undefined : { headers: { authorization: token } };
    function ServerView() {
      return <span>{useQuery(serverApi.me.get, options).data?.name ?? "Loading"}</span>;
    }
    const html = renderToString(
      withDocumentState(
        <ServerView />,
        {
          buildId: undefined,
          entryModule: undefined,
          faviconHref: undefined,
          frameworkModules: [],
          staticMode: false,
          stylesheets: [],
        },
        undefined,
        loaded.syncData
      )
    );
    expect(html).toBe("<span>Loading</span>");
    const queries = new QueryStore(undefined);
    queries.hydrate(loaded.syncData.__furinQueries as QuerySeed[], window.location.origin);
    const ready = Promise.withResolvers<void>();
    const browserApi = createClient<typeof app>(window.location.origin, {
      fetcher: (async (input, init) => {
        await ready.promise;
        return app.handle(new Request(input, init));
      }) as typeof fetch,
    });
    function View() {
      return <span>{useQuery(browserApi.me.get, options).data?.name ?? "Loading"}</span>;
    }
    const container = document.createElement("div");
    container.innerHTML = html;
    await act(() => {
      root = hydrateRoot(
        container,
        <QueryStoreContext.Provider value={queries}>
          <View />
        </QueryStoreContext.Provider>
      );
    });
    try {
      expect(container.textContent).toBe("Loading");
    } finally {
      await act(async () => {
        ready.resolve();
        await Promise.resolve();
      });
      autoInvalidateRegistry.unregisterPath("/credential-seed-test");
    }
    expect(container.textContent).toBe(expected);
  }
);

test("changing query credentials fetches the new principal's result", async () => {
  let reads = 0;
  const app = new Elysia().get("/me", ({ headers, set }) => {
    reads += 1;
    set.headers["x-furin-query"] = JSON.stringify({
      id: "me",
      scope: {},
      session: headers.authorization,
    });
    return { name: headers.authorization };
  });
  const api = createClient<typeof app>(window.location.origin, {
    fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  function View({ token }: { token: string }) {
    return <span>{useQuery(api.me.get, { headers: { authorization: token } }).data?.name}</span>;
  }
  const container = document.createElement("div");
  const viewRoot = createRoot(container);
  root = viewRoot;
  await act(async () => viewRoot.render(<View token="Alice" />));
  expect(container.textContent).toBe("Alice");
  await act(async () => viewRoot.render(<View token="Bob" />));
  expect(container.textContent).toBe("Bob");
  expect(reads).toBe(2);
});

test.each([
  { name: "Date", value: () => new Date("2026-01-01T00:00:00Z"), supported: true },
  { name: "BigInt", value: () => 1n, supported: false },
  {
    name: "cyclic objects",
    supported: false,
    value: () => {
      const value: { self?: object } = {};
      value.self = value;
      return value;
    },
  },
])(
  "$name header values preserve Eden results and errors without crashing React",
  async ({ value, supported }) => {
    let reads = 0;
    const app = new Elysia().get(
      "/header",
      { headers: t.Object({ "x-option": t.Any() }) },
      ({ headers }) => {
        reads += 1;
        return { received: headers["x-option"] };
      }
    );
    const api = createClient<typeof app>(window.location.origin, {
      parseDate: false,
      fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
    });
    const first = value();
    const second = value();
    function View({ header }: { header: unknown }) {
      const result = useQuery(api.header.get, { headers: { "x-option": header } });
      return <span>{result.error ? "Request failed" : result.data?.received}</span>;
    }
    const container = document.createElement("div");
    const viewRoot = createRoot(container);
    root = viewRoot;
    await act(async () =>
      viewRoot.render(
        <>
          <View header={first} />
          <View header={second} />
        </>
      )
    );
    expect(container.textContent).toBe((supported ? String(first) : "Request failed").repeat(2));
    expect(reads).toBe(supported ? 1 : 0);
  }
);

test("simultaneous query principals keep separate results and share equivalent reads", async () => {
  let reads = 0;
  const app = new Elysia().get("/me", ({ headers, set }) => {
    reads += 1;
    set.headers["x-furin-query"] = JSON.stringify({
      id: "me",
      scope: {},
      session: headers.authorization,
    });
    return { name: headers.authorization };
  });
  const api = createClient<typeof app>(window.location.origin, {
    fetcher: ((input, init) => app.handle(new Request(input, init))) as typeof fetch,
  });
  function View({ token }: { token: string }) {
    return <span>{useQuery(api.me.get, { headers: { authorization: token } }).data?.name}</span>;
  }
  const container = document.createElement("div");
  const viewRoot = createRoot(container);
  root = viewRoot;
  await act(async () =>
    viewRoot.render(
      <>
        <View token="Alice" />
        <View token="Bob" />
        <View token="Alice" />
      </>
    )
  );
  expect(container.textContent).toBe("AliceBobAlice");
  expect(reads).toBe(2);
});

test("two Eden query consumers share a fetch and an optimistic projection", async () => {
  let reads = 0;
  let title = "Before";
  const gate = Promise.withResolvers<void>();
  const app = new Elysia()
    .get("/cards", () => {
      reads += 1;
      return [{ id: "1", title }];
    })
    .patch("/cards", async () => {
      await gate.promise;
      title = "After";
      return { ok: true };
    });
  const api = createClient(app);
  function View() {
    const { data } = useQuery(api.cards.get);
    return <span>{data?.[0]?.title}</span>;
  }
  const container = document.createElement("div");
  const viewRoot = createRoot(container);
  root = viewRoot;
  await act(async () => {
    viewRoot.render(
      <>
        <View />
        <View />
      </>
    );
    await Promise.resolve();
  });
  expect(container.textContent).toBe("BeforeBefore");
  expect(reads).toBe(1);
  let mutation: ReturnType<typeof api.cards.patch>;
  await act(async () => {
    mutation = api.cards.patch(undefined, {
      optimistic(cache) {
        cache.update(api.cards.get, (cards) => cards.map((card) => ({ ...card, title: "After" })));
      },
    });
    await Promise.resolve();
  });
  expect(container.textContent).toBe("AfterAfter");
  await act(async () => {
    gate.resolve();
    await mutation;
  });
  expect(container.textContent).toBe("AfterAfter");
  expect(reads).toBe(2);
});
