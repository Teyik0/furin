import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { withSync } from "../../../src/client.ts";

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
  await withSync(client).cards.post({ a: 1 }, options);
  expect(types).toEqual(["application/custom+json", "application/custom+json"]);
});

test("preserves explicit content type from every literal header form", async () => {
  const app = new Elysia().post("/cards", () => ({ ok: true }));
  const types: Array<string | null> = [];
  const client = treaty<typeof app>("http://localhost", {
    fetcher: ((input, init) => {
      types.push(new Request(input, init).headers.get("content-type"));
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch,
  });
  const forms: HeadersInit[] = [
    { "Content-Type": "application/custom+json" },
    new Headers({ "Content-Type": "application/custom+json" }),
    [["Content-Type", "application/custom+json"]],
  ];
  for (const headers of forms) {
    // biome-ignore lint/performance/noAwaitInLoops: verify each supported header form separately.
    await Reflect.apply(withSync(client).cards.post, undefined, [{ a: 1 }, { headers }]);
  }
  expect(types).toEqual(new Array(3).fill("application/custom+json"));
});

test("generates an idempotency key when randomUUID is unavailable", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
  const app = new Elysia().post("/cards", ({ headers }) => headers["idempotency-key"]);
  try {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
    const first = await withSync(treaty(app)).cards.post();
    const second = await withSync(treaty(app)).cards.post();
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

test("keeps Eden results and supplies a new idempotency key per mutation", async () => {
  const keys: string[] = [];
  const app = new Elysia().post(
    "/cards/:id",
    { body: t.Object({ title: t.String() }) },
    ({ body, headers }) => {
      keys.push(headers["idempotency-key"] ?? "");
      return body;
    }
  );
  const api = withSync(treaty(app));
  const first = await api.cards({ id: "1" }).post({ title: "first" });
  const second = await api.cards({ id: "1" }).post({ title: "second" });
  expect(first.data).toEqual({ title: "first" });
  expect(first.error).toBeNull();
  expect(second.data).toEqual({ title: "second" });
  expect(keys.every((key) => key.length > 0)).toBe(true);
  expect(keys[0]).not.toBe(keys[1]);
});

test("retries only explicit in-progress responses with the same key", async () => {
  const keys: string[] = [];
  const app = new Elysia().post("/cards", ({ headers }) => {
    keys.push(headers["idempotency-key"] ?? "");
    return keys.length < 3
      ? Response.json(
          { code: "FURIN_MUTATION_IN_PROGRESS" },
          { status: 409, headers: { "Retry-After": "0" } }
        )
      : { ok: true };
  });
  const api = withSync(treaty(app), { retry: 2 });
  const result = await api.cards.post();
  expect(result.error).toBeNull();
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(1);
});

test("leaves reads untouched and preserves a case-insensitive explicit key", async () => {
  const app = new Elysia()
    .get("/cards", () => ({ count: 1 }))
    .post("/cards", ({ headers }) => ({ key: headers["idempotency-key"], custom: headers.custom }));
  const api = withSync(treaty(app));
  expect((await api.cards.get()).data).toEqual({ count: 1 });
  const result = await api.cards.post(undefined, {
    headers: { "idempotency-key": "chosen", custom: "value" },
  });
  expect(result.data).toEqual({ key: "chosen", custom: "value" });
});

test("never retries business errors, unsafe server failures, or lost network responses", async () => {
  for (const status of [422, 500, 503]) {
    let attempts = 0;
    const app = new Elysia().post("/cards", () => {
      attempts += 1;
      return Response.json({ code: "FURIN_SYNC_LEASE_LOST" }, { status });
    });
    // biome-ignore lint/performance/noAwaitInLoops: isolated cases must finish before asserting request counts.
    const result = await withSync(treaty(app), { retry: 2 }).cards.post();
    expect(result.error).not.toBeNull();
    expect(attempts).toBe(1);
  }
  let attempts = 0;
  const app = new Elysia().post("/cards", () => ({ ok: true }));
  const api = withSync(
    treaty<typeof app>("http://localhost", {
      fetcher: (() => {
        attempts += 1;
        return Promise.reject(new TypeError("connection lost"));
      }) as unknown as typeof fetch,
    }),
    { retry: 2 }
  );
  expect((await api.cards.post()).error).not.toBeNull();
  expect(attempts).toBe(1);
});

test("preserves Eden throwHttpError network rejection without retrying", async () => {
  let attempts = 0;
  const app = new Elysia().post("/cards", () => ({ ok: true }));
  const api = withSync(
    treaty<typeof app>("http://localhost", {
      throwHttpError: true,
      fetcher: (() => {
        attempts += 1;
        return Promise.reject(new TypeError("network unavailable"));
      }) as unknown as typeof fetch,
    }),
    { retry: 5 }
  );
  await expect(api.cards.post()).rejects.toMatchObject({ status: 503 });
  expect(attempts).toBe(1);
});

test("cancellation stops a scheduled retry without sending another request", async () => {
  const controller = new AbortController();
  const requested = Promise.withResolvers<void>();
  let attempts = 0;
  const app = new Elysia().post("/cards", () => {
    attempts += 1;
    requested.resolve();
    return Response.json(
      { code: "FURIN_MUTATION_IN_PROGRESS" },
      { status: 409, headers: { "Retry-After": "10" } }
    );
  });
  const api = withSync(treaty(app), { retry: 2 });
  const result = api.cards.post(undefined, { fetch: { signal: controller.signal } });
  await requested.promise;
  await new Promise((resolve) => setTimeout(resolve, 5));
  controller.abort();
  expect((await result).error).not.toBeNull();
  expect(attempts).toBe(1);
});

test("an inline zero retry overrides the client policy", async () => {
  let attempts = 0;
  const app = new Elysia().post("/cards", () => {
    attempts += 1;
    return Response.json(
      { code: "FURIN_MUTATION_IN_PROGRESS" },
      { status: 409, headers: { "Retry-After": "0" } }
    );
  });
  const result = await withSync(treaty(app), { retry: 2 }).cards.post(undefined, { retry: 0 });
  expect(result.error).not.toBeNull();
  expect(attempts).toBe(1);
});

test("preserves Eden throwHttpError through retries", async () => {
  let attempts = 0;
  const app = new Elysia().post("/cards", () => {
    attempts += 1;
    return attempts === 1
      ? Response.json(
          { code: "FURIN_MUTATION_IN_PROGRESS" },
          { status: 409, headers: { "Retry-After": "0" } }
        )
      : { ok: true };
  });
  const result = await withSync(treaty(app, { throwHttpError: true }), { retry: 1 }).cards.post();
  expect(result.error).toBeNull();
  expect(attempts).toBe(2);
  const rejected = new Elysia().post("/cards", () =>
    Response.json({ message: "rejected" }, { status: 422 })
  );
  await expect(
    withSync(treaty(rejected, { throwHttpError: true })).cards.post()
  ).rejects.toMatchObject({ status: 422 });
});

test("retains dynamic Eden headers and explicit fetch headers", async () => {
  const app = new Elysia().post("/cards", ({ headers }) => ({
    key: headers["idempotency-key"],
    custom: headers.custom,
    authorization: headers.authorization,
  }));
  const api = withSync(treaty(app, { headers: { authorization: "Bearer token" } }));
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
