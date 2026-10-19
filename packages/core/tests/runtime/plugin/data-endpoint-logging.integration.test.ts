import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { setFurinEvlogOptions } from "../../../src/server/evlog.ts";
import { captureEvlogEvents } from "../../support/evlog-capture.ts";
import { runProcess } from "../../support/process.ts";

const { __resetCompileContext } = await import("../../../src/server/internal.ts");
const { __setDevMode } = await import("../../../src/server/runtime-env");
const { mountProductionPages } = await import("../../support/production-app.ts");

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");

afterEach(() => {
  __setDevMode(process.env.NODE_ENV !== "production");
  __resetCompileContext();
});

test("navigation data requests enrich matching route events", async () => {
  __setDevMode(false);
  const { app, instance } = await mountProductionPages(fixturesDir, "");
  const capture = captureEvlogEvents();
  setFurinEvlogOptions(instance, { drain: capture.drain });
  const event = capture.next();

  const response = await app.handle(new Request("http://localhost/dynamic/42?_furin=data"));
  await response.text();

  expect(await event).toMatchObject({ path: "/dynamic/42", routePattern: "/dynamic/:id" });
});

test("navigation data requests for unknown paths get an uncached 404 without a route", async () => {
  __setDevMode(false);
  const { app, instance } = await mountProductionPages(fixturesDir, "");
  const capture = captureEvlogEvents();
  setFurinEvlogOptions(instance, { drain: capture.drain });
  const event = capture.next();

  const res = await app.handle(new Request("http://localhost/nope/nowhere?_furin=data"));

  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.text()).toBe("");
  expect(await event).not.toHaveProperty("routePattern");
});

test("the real Elysia integration exposes a request-scoped logger", async () => {
  const result = await runProcess(
    [
      "bun",
      "-e",
      `
import { Elysia } from "elysia";
import { createFurinEvlog, getRequestLogger } from "./src/server/evlog.ts";

const app = new Elysia()
  .use(createFurinEvlog({}))
  .get("/", () => {
    getRequestLogger().set({ integration: "active" });
    return "ok";
  });
const response = await app.handle(new Request("http://localhost/"));
if (response.status !== 200 || (await response.text()) !== "ok") process.exit(1);
process.stdout.write("logger-active");
`,
    ],
    { cwd: join(import.meta.dir, "../../.."), env: { NODE_ENV: "test" }, timeoutMs: 25_000 }
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("logger-active");
}, 30_000);
