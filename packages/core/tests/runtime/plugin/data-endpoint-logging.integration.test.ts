import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { evlogSetMock, resetEvlogMock } from "../../setup/evlog-mock";

const { scanPages } = await import("../../../src/server/router/discovery.ts");
const { createDataEndpoint } = await import("../../../src/server/router/plugin.ts");
const { createFurinEvlog } = await import("../../../src/server/evlog.ts");
const { __setDevMode } = await import("../../../src/server/runtime-env");

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");

interface LogFields {
  path?: string;
  routePattern?: string;
  [key: string]: unknown;
}

afterEach(() => {
  __setDevMode(process.env.NODE_ENV !== "production");
  resetEvlogMock();
});

test("GET /_furin/data enriches matching route events", async () => {
  __setDevMode(false);

  const scanned = await scanPages(fixturesDir);
  const app = new Elysia().use(createFurinEvlog({})).use(createDataEndpoint(scanned.routes));

  await app.handle(new Request("http://localhost/_furin/data?path=%2Fdynamic%2F42"));

  const merged = evlogSetMock.mock.calls.reduce<LogFields>(
    (acc, [arg]) => Object.assign(acc, arg),
    {}
  );
  expect(merged.path).toBe("/dynamic/42");
  expect(merged.routePattern).toBe("/dynamic/:id");
});

test("GET /_furin/data enriches not-found route events", async () => {
  __setDevMode(false);

  const scanned = await scanPages(fixturesDir);
  const app = new Elysia().use(createFurinEvlog({})).use(createDataEndpoint(scanned.routes));

  const res = await app.handle(new Request("http://localhost/_furin/data?path=%2Fnope%2Fnowhere"));

  expect(res.status).toBe(404);
  const enrichingCall = evlogSetMock.mock.calls.find(([arg]) => arg.path === "/nope/nowhere");
  expect(enrichingCall).toBeDefined();
});

test("the real Elysia integration exposes a request-scoped logger", () => {
  const result = Bun.spawnSync({
    cmd: [
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
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stdout.toString()).toContain("logger-active");
});
