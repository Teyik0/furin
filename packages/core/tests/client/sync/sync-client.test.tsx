import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { furinSync } from "../../../src/client.ts";

test("an awaited live query resolves like the plain Eden GET", async () => {
  const app = new Elysia().get("/cards/:id", ({ params }) => ({ id: params.id }));
  const api = treaty(app).use(furinSync);
  const live = await api.cards({ id: "a/b c" }).get.live();
  const plain = await api.cards({ id: "a/b c" }).get();
  expect(live.error).toBeNull();
  expect(live.data).toEqual({ id: "a/b c" });
  expect(live.data).toEqual(plain.data);
});

test("a route segment named live fails loudly instead of reading the wrong route", () => {
  const app = new Elysia().get("/streams/live/:id", ({ params }) => params.id);
  const api = treaty(app).use(furinSync);
  expect(() => api.streams.live({ id: "1" })).toThrow("reserved by furinSync");
});

test("a call without options stays a plain Eden call", async () => {
  const app = new Elysia().post("/cards", ({ headers }) => ({ key: headers["idempotency-key"] }));
  const result = await treaty(app).use(furinSync).cards.post();
  expect(result.error).toBeNull();
  expect(result.data?.key).toBeUndefined();
});

test("preserves Eden's explicit content type after body serialization", async () => {
  const app = new Elysia().post(
    "/cards",
    { body: t.Object({ a: t.Number() }) },
    ({ body }) => body
  );
  const types: Array<string | null> = [];
  const fetcher: typeof fetch = ((input, init) => {
    types.push(new Request(input, init).headers.get("content-type"));
    return Promise.resolve(Response.json({ a: 1 }));
  }) as typeof fetch;
  const client = treaty<typeof app>("http://localhost", { fetcher });
  const options = {
    headers: { "content-type": "application/custom+json", name: "Ada", length: "1" },
  };
  await client.cards.post({ a: 1 }, options);
  await client.use(furinSync).cards.post({ a: 1 }, options);
  expect(types).toEqual(["application/custom+json", "application/custom+json"]);
});

test("a synced call sends every header form exactly like plain Eden", async () => {
  const app = new Elysia().post("/cards", () => ({ ok: true }));
  const sent: string[] = [];
  const client = treaty<typeof app>("http://localhost", {
    fetcher: ((input, init) => {
      const { headers } = new Request(input, init);
      sent.push(`${headers.get("content-type")} ${headers.get("x-custom")}`);
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch,
  });
  const forms: HeadersInit[] = [
    { "Content-Type": "application/custom+json", "X-Custom": "object" },
    new Headers({ "Content-Type": "application/custom+json", "X-Custom": "headers" }),
    [
      ["Content-Type", "application/custom+json"],
      ["X-Custom", "tuples"],
    ],
  ];
  for (const headers of forms) {
    // biome-ignore lint/performance/noAwaitInLoops: compare each header form separately.
    await Reflect.apply(client.cards.post, undefined, [{ a: 1 }, { headers }]);
    await Reflect.apply(client.use(furinSync).cards.post, undefined, [{ a: 1 }, { headers }]);
  }
  expect(sent.filter((_, index) => index % 2 === 1)).toEqual(
    sent.filter((_, index) => index % 2 === 0)
  );
  expect(sent.filter((_, index) => index % 2 === 1).map((line) => line.split(" ")[1])).toEqual([
    "object",
    "headers",
    "tuples",
  ]);
});

test("generates an idempotency key when randomUUID is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  const app = new Elysia().post("/cards", ({ headers }) => headers["idempotency-key"]);
  const api = treaty(app).use(furinSync);
  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    const first = await api.cards.post(undefined, {});
    const second = await api.cards.post(undefined, {});
    expect(first.error).toBeNull();
    expect(first.data).toBeString();
    expect(first.data).not.toBe(second.data);
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis.crypto, "randomUUID", descriptor);
    } else {
      Reflect.deleteProperty(globalThis.crypto, "randomUUID");
    }
  }
});

test("a reused options object gets a new key per call and is never altered", async () => {
  const keys: string[] = [];
  const app = new Elysia().post(
    "/cards/:id",
    { body: t.Object({ title: t.String() }) },
    ({ body, headers }) => {
      keys.push(headers["idempotency-key"] ?? "");
      return body;
    }
  );
  const api = treaty(app).use(furinSync);
  const options = { headers: { "x-trace": "1" } };
  const [first, second] = await Promise.all([
    api.cards({ id: "1" }).post({ title: "first" }, options),
    api.cards({ id: "1" }).post({ title: "second" }, options),
  ]);
  expect(first.data).toEqual({ title: "first" });
  expect(second.data).toEqual({ title: "second" });
  expect(keys.every((key) => key.length > 0)).toBe(true);
  expect(new Set(keys).size).toBe(2);
  expect(options).toEqual({ headers: { "x-trace": "1" } });
});

test("leaves reads untouched and preserves a case-insensitive explicit key", async () => {
  const app = new Elysia()
    .get("/cards", () => ({ count: 1 }))
    .post("/cards", ({ headers }) => ({ key: headers["idempotency-key"], custom: headers.custom }));
  const api = treaty(app).use(furinSync);
  expect((await api.cards.get()).data).toEqual({ count: 1 });
  const result = await api.cards.post(undefined, {
    headers: { "Idempotency-Key": "chosen", custom: "value" },
  });
  expect(result.data).toEqual({ key: "chosen", custom: "value" });
});

test("retains dynamic Eden headers and explicit fetch headers", async () => {
  const app = new Elysia().post("/cards", ({ headers }) => ({
    key: headers["idempotency-key"],
    custom: headers.custom,
    authorization: headers.authorization,
  }));
  const api = treaty(app, { headers: { authorization: "Bearer token" } }).use(furinSync);
  const callback = await api.cards.post(undefined, {
    headers: () => ({ "idempotency-key": "callback", custom: "dynamic" }),
  });
  expect(callback.data).toEqual({
    key: "callback",
    custom: "dynamic",
    authorization: "Bearer token",
  });
  const explicit = await api.cards.post(undefined, {
    fetch: { headers: new Headers({ "Idempotency-Key": "explicit", custom: "fetch" }) },
  });
  expect(explicit.data).toMatchObject({ key: "explicit", custom: "fetch" });
});

test("preserves Eden throwHttpError and network rejections", async () => {
  const rejected = new Elysia().post("/cards", () =>
    Response.json({ message: "rejected" }, { status: 422 })
  );
  await expect(
    treaty(rejected, { throwHttpError: true }).use(furinSync).cards.post(undefined, {})
  ).rejects.toMatchObject({ status: 422 });
  const offline = treaty<typeof rejected>("http://localhost", {
    throwHttpError: true,
    fetcher: (() =>
      Promise.reject(new TypeError("network unavailable"))) as unknown as typeof fetch,
  }).use(furinSync);
  await expect(offline.cards.post(undefined, {})).rejects.toMatchObject({ status: 503 });
});
