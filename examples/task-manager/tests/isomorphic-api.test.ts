import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { createIsomorphicFn } from "@teyik0/furin";
import { Elysia } from "elysia";

test("the server Eden branch executes Elysia without an HTTP fetch", async () => {
  const app = new Elysia().get("/ping", () => ({ ok: true }));
  const getApi = createIsomorphicFn()
    .server(() => treaty(app))
    .client(() => treaty<typeof app>("http://localhost:3002"));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("unexpected HTTP fetch");
  }) as typeof fetch;

  try {
    const response = await getApi().ping.get();

    expect(response.status).toBe(200);
    expect(response.data).toEqual({ ok: true });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
