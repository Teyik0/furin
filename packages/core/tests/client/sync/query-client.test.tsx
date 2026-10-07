import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createClient, useQuery } from "../../../src/client.ts";
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
