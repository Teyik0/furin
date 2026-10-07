import { expect, test } from "bun:test";
import { QueryStore } from "../../../src/client/query-store.ts";

const url = "http://localhost/cards";
const identity = { id: "board.cards", scope: { boardId: "alpha" }, session: "alice" };
function result(data: unknown, session: string) {
  return {
    data,
    error: null,
    response: new Response(null, {
      headers: { "x-furin-query": JSON.stringify({ ...identity, session }) },
    }),
  };
}

test("request-specific seeds retain isolated identities without serializing credentials", () => {
  const store = new QueryStore(undefined);
  const reference = { client: store, url, load: async () => result("Alice", "alice") };
  const aliceKey = store.readKey(reference, { headers: { Authorization: "Bearer private-alice" } });
  store.observe(aliceKey, result("Alice", "alice"), store.generation());
  expect(store.dehydrate()).toMatchObject([{ url: aliceKey, data: "Alice", identity }]);
  expect(JSON.stringify(store.dehydrate())).not.toContain("private-alice");
  const bobKey = store.readKey(reference, { headers: { Authorization: "Bearer private-bob" } });
  store.observe(bobKey, result("Bob", "bob"), store.generation());
  expect(store.snapshot(aliceKey).data).toBe("Alice");
  expect(store.snapshot(bobKey).data).toBe("Bob");
  expect(store.dehydrate()).toMatchObject([
    { url: aliceKey, data: "Alice", identity },
    { url: bobKey, data: "Bob", identity: { session: "bob" } },
  ]);
  expect(JSON.stringify(store.dehydrate())).not.toContain("private-bob");
  const browser = new QueryStore(undefined);
  browser.hydrate(store.dehydrate(), "https://browser.example");
  expect(browser.snapshot("https://browser.example/cards").data).toBeUndefined();
  const browserReference = {
    ...reference,
    client: browser,
    url: "https://browser.example/cards",
  };
  const browserAlice = browser.readKey(browserReference, {
    headers: { Authorization: "Bearer private-alice" },
  });
  expect(browser.snapshot(browserAlice).data).toBeUndefined();
});

test("a stale read cannot confirm an optimistic increment twice", async () => {
  const store = new QueryStore(undefined);
  store.observe(url, result(0, "alice"), store.generation());
  const stale = Promise.withResolvers<ReturnType<typeof result>>();
  let reads = 0;
  store.bind(url, () => {
    reads += 1;
    return reads === 1 ? stale.promise : Promise.resolve(result(1, "alice"));
  });
  store.subscribe(url, () => undefined);
  store.invalidate([identity]);
  await Promise.resolve();
  const projection = store.begin();
  store.update(projection, url, (data) => Number(data) + 1);
  stale.resolve(result(1, "alice"));
  await store.fetch(url);
  expect(store.snapshot(url).data).toBe(1);
  store.finish(projection, "success");
  await store.fetch(url);
  expect(store.snapshot(url).data).toBe(1);
  expect(reads).toBe(2);
});

test("late streamed hydration cannot replace a newer committed mutation or another session", () => {
  const store = new QueryStore(undefined);
  store.observe(url, result(0, "alice"), store.generation());
  const hydrate = store.captureHydration();
  const projection = store.begin();
  store.update(projection, url, (value) => Number(value) + 1);
  store.finish(projection, "success");
  store.observe(url, result(1, "alice"), store.generation());
  hydrate([{ url, identity, data: 0 }], undefined);
  expect(store.snapshot(url).data).toBe(1);
  store.observe(url, result(2, "bob"), store.generation());
  hydrate([{ url, identity, data: 0 }], undefined);
  expect(store.snapshot(url).data).toBe(2);
});

test("a completed GET supersedes an older streamed snapshot", () => {
  const store = new QueryStore(undefined);
  store.observe(url, result(0, "alice"), store.generation());
  const hydrate = store.captureHydration();
  store.observe(url, result(1, "alice"), store.generation());
  hydrate([{ url, identity, data: 0 }], undefined);
  expect(store.snapshot(url).data).toBe(1);
});

test("rollback removes only its own contribution and holds reads until other writes settle", async () => {
  const store = new QueryStore(undefined);
  store.observe(url, result(0, "alice"), store.generation());
  let reads = 0;
  store.bind(url, () => {
    reads += 1;
    return Promise.resolve(result(1, "alice"));
  });
  const a = store.begin();
  const b = store.begin();
  store.update(a, url, (value) => Number(value) + 1);
  store.update(b, url, (value) => Number(value) + 1);
  expect(store.snapshot(url).data).toBe(2);
  store.invalidate([identity]);
  store.finish(a, "error");
  expect(store.snapshot(url).data).toBe(1);
  expect(reads).toBe(0);
  store.finish(b, "success");
  await store.fetch(url);
  expect(store.snapshot(url).data).toBe(1);
});

test("scoped invalidation refreshes all variants of one board and leaves another board fresh", async () => {
  const store = new QueryStore(undefined);
  let reads = 0;
  for (const path of [`${url}?filter=done`, `${url}?filter=todo`, `${url}/other`]) {
    const response = result(path, "alice");
    if (path.endsWith("other")) {
      response.response.headers.set(
        "x-furin-query",
        JSON.stringify({ ...identity, scope: { boardId: "beta" } })
      );
    }
    store.observe(path, response, store.generation());
    store.bind(path, () => {
      reads += 1;
      return Promise.resolve(response);
    });
    store.subscribe(path, () => undefined);
  }
  store.invalidate([identity]);
  await Promise.all([
    store.fetch(`${url}?filter=done`),
    store.fetch(`${url}?filter=todo`),
    store.fetch(`${url}/other`),
  ]);
  expect(reads).toBe(2);
});

test("a different principal clears the old session and discards its in-flight responses", () => {
  const store = new QueryStore(undefined);
  const oldGeneration = store.generation();
  store.observe(url, result("Alice", "alice"), oldGeneration);
  store.observe(`${url}/private`, result("Alice private", "alice"), oldGeneration);
  store.observe(url, result("Bob", "bob"), oldGeneration);
  expect(store.snapshot(`${url}/private`).data).toBeUndefined();
  store.observe(url, result("Late Alice", "alice"), oldGeneration);
  expect(store.snapshot(url).data).toBe("Bob");
});

test("a session change releases mutation projections", () => {
  const store = new QueryStore(undefined);
  store.observe(url, result(0, "alice"), store.generation());
  const projection = store.begin();
  let removed = 0;
  projection.onRemove = () => {
    removed += 1;
  };
  store.update(projection, url, (value) => Number(value) + 1);
  store.observe(`${url}/session`, result(2, "bob"), store.generation());
  expect(removed).toBe(1);
  expect(store.snapshot(url).data).toBeUndefined();
});

test("hydration remaps an in-process Eden origin and avoids a duplicate initial GET", async () => {
  const store = new QueryStore("https://app.example");
  store.hydrate([{ url, identity, data: ["SSR"], local: true }], "https://app.example");
  let reads = 0;
  store.bind("https://app.example/cards", () => {
    reads += 1;
    return Promise.resolve(result([], "alice"));
  });
  await store.fetch("https://app.example/cards");
  expect(store.snapshot("https://app.example/cards").data).toEqual(["SSR"]);
  expect(reads).toBe(0);
});

test("hydration preserves external origins when serialized again", () => {
  const store = new QueryStore("https://app.example");
  store.hydrate([{ url: "https://api.example/cards", identity, data: [], local: false }]);
  expect(store.dehydrate()).toMatchObject([{ url: "https://api.example/cards", local: false }]);
});

test("journal retention resets revalidate observed reads even without loader dependencies", async () => {
  const store = new QueryStore(undefined);
  store.observe(url, result("Before", "alice"), store.generation());
  store.bind(url, () => Promise.resolve(result("After", "alice")));
  store.subscribe(url, () => undefined);
  store.invalidateAll();
  await store.fetch(url);
  expect(store.snapshot(url).data).toBe("After");
});

test("an invalidation during error recovery schedules the newest read", async () => {
  const store = new QueryStore(undefined);
  store.observe(url, result(0, "alice"), store.generation());
  const stale = Promise.withResolvers<ReturnType<typeof result>>();
  let reads = 0;
  store.bind(url, () => {
    reads += 1;
    if (reads === 1) {
      return Promise.reject(new Error("Unavailable"));
    }
    return reads === 2 ? stale.promise : Promise.resolve(result(2, "alice"));
  });
  store.subscribe(url, () => undefined);
  store.invalidate([identity]);
  await store.fetch(url);
  store.invalidate([identity]);
  await Promise.resolve();
  store.invalidate([identity]);
  stale.resolve(result(1, "alice"));
  await store.fetch(url);
  await Bun.sleep(0);
  expect(reads).toBe(3);
  expect(store.snapshot(url).data).toBe(2);
});
