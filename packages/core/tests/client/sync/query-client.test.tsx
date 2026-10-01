import "../../setup/global.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createClient, useQuery } from "../../../src/client.ts";
import { installDom, uninstallDom } from "../../support/dom.ts";

let root: Root;
beforeEach(() => {
  installDom();
});
afterEach(async () => {
  await act(() => root.unmount());
  uninstallDom();
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
  root = createRoot(container);
  await act(async () => {
    root.render(
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
