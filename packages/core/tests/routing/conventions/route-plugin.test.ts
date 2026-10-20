import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionPages } from "../../support/production-app.ts";

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");
const originalDevMode = IS_DEV;

beforeEach(() => {
  __setDevMode(false);
});

afterEach(() => {
  __resetCompileContext();
  __setDevMode(originalDevMode);
});

test("production pages render documents for every rendering mode", async () => {
  const { app } = await mountProductionPages(fixturesDir, "");

  await Promise.all(
    ["/ssg-page", "/ssr-page", "/isr-page"].map(async (path) => {
      const res = await app.handle(new Request(`http://localhost${path}`));
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      expect(await res.text(), path).toContain("<!DOCTYPE html>");
    })
  );
});

test("production pages apply query schema defaults without redirecting", async () => {
  const { app } = await mountProductionPages(fixturesDir, "");

  const defaulted = await app.handle(new Request("http://localhost/query-default"));
  expect(defaulted.status).toBe(200);
  expect(defaulted.headers.get("location")).toBeNull();
  expect(await defaulted.text()).toContain('data-city="Paris"');

  const explicit = await Promise.all(
    ["Paris", "Tokyo"].map((city) =>
      app.handle(new Request(`http://localhost/query-default?city=${city}`))
    )
  );
  expect(explicit.map((res) => res.status)).toEqual([200, 200]);
});
