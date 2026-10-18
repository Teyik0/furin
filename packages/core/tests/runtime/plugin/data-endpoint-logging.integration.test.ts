import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { evlogSetMock, resetEvlogMock } from "../../setup/evlog-mock";
import { runProcess } from "../../support/process.ts";

const { __resetCompileContext } = await import("../../../src/server/internal.ts");
const { __setDevMode } = await import("../../../src/server/runtime-env");
const { mountProductionPages } = await import("../../support/production-app.ts");

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");

interface LogFields {
  path?: string;
  routePattern?: string;
  [key: string]: unknown;
}

afterEach(() => {
  __setDevMode(process.env.NODE_ENV !== "production");
  __resetCompileContext();
  resetEvlogMock();
});

test("navigation data requests enrich matching route events", async () => {
  __setDevMode(false);
  const { app } = await mountProductionPages(fixturesDir, "");

  await app.handle(new Request("http://localhost/dynamic/42?_furin=data"));

  const merged = evlogSetMock.mock.calls.reduce<LogFields>(
    (acc, [arg]) => Object.assign(acc, arg),
    {}
  );
  expect(merged.path).toBe("/dynamic/42");
  expect(merged.routePattern).toBe("/dynamic/:id");
});

test("navigation data requests for unknown paths get an uncached 404 without a route", async () => {
  __setDevMode(false);
  const { app } = await mountProductionPages(fixturesDir, "");

  const res = await app.handle(new Request("http://localhost/nope/nowhere?_furin=data"));

  expect(res.status).toBe(404);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.text()).toBe("");
  const routePatterns = evlogSetMock.mock.calls.flatMap(([arg]) =>
    arg.routePattern === undefined ? [] : [arg.routePattern]
  );
  expect(routePatterns).toEqual([]);
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
