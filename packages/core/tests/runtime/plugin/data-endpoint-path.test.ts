import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createDataEndpoint } from "../../../src/server/router/plugin.ts";

test("navigation data requires a safe logical path without a TypeBox route schema", async () => {
  const app = new Elysia().use(createDataEndpoint([]));

  const missing = await app.handle(new Request("http://localhost/_furin/data"));
  const external = await app.handle(
    new Request("http://localhost/_furin/data?path=https%3A%2F%2Fevil.example%2F")
  );
  const valid = await app.handle(new Request("http://localhost/_furin/data?path=%2Fmissing"));

  expect(missing.status).toBe(400);
  expect(external.status).toBe(400);
  expect(valid.status).toBe(404);
});
