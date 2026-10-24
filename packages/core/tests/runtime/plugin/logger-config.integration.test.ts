import { expect, test } from "bun:test";
import { join } from "node:path";
import { runProcess } from "../../support/process.ts";

test("Furin instances preserve the application's global logger configuration", async () => {
  const result = await runProcess(
    [
      process.execPath,
      "-e",
      `
import assert from "node:assert/strict";
import { getEnvironment, initLogger, log } from "evlog";
import { defineRootRoute } from "./src/furin.ts";
import { setRuntimeEvlogWaitUntil } from "./src/server/evlog.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { mountProductionApp } from "./tests/support/production-app.ts";

const events = [];
const pending = [];
initLogger({
  env: { service: "host-app", environment: "test" },
  drain: ({ event }) => { events.push(event); },
  redact: { paths: ["secret"] },
  sampling: { rates: { debug: 0, info: 100 } },
  silent: true,
});
__setDevMode(false);
setRuntimeEvlogWaitUntil((emission) => { pending.push(emission); });
for (const prefix of ["", "/admin"]) {
  const { app } = await mountProductionApp({
    buildId: "logger-config",
    pages: [],
    prefix,
    root: defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children),
  });
  assert.equal(getEnvironment().service, "host-app");
  app.get(prefix + "/probe", ({ log }) => {
    log.set({ secret: "request-secret" });
    return "ok";
  });
  const response = await app.handle(new Request("http://localhost" + prefix + "/probe"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  await Promise.all(pending);
}
log.debug({ marker: "sampled-out" });
log.info({ marker: "application", secret: "application-secret" });
process.stdout.write(JSON.stringify(events));
`,
    ],
    { cwd: join(import.meta.dir, "../../.."), env: { NODE_ENV: "test" }, timeoutMs: 10_000 }
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([
    expect.objectContaining({
      path: "/probe",
      secret: "[REDACTED]",
      service: "host-app",
      environment: "test",
    }),
    expect.objectContaining({
      path: "/admin/probe",
      secret: "[REDACTED]",
      service: "host-app",
      environment: "test",
    }),
    expect.objectContaining({
      marker: "application",
      secret: "[REDACTED]",
      service: "host-app",
      environment: "test",
    }),
  ]);
});

test("Furin serves requests and drains request logs without initLogger", async () => {
  const result = await runProcess(
    [
      process.execPath,
      "-e",
      `
import assert from "node:assert/strict";
import { defineRootRoute } from "./src/furin.ts";
import { setFurinEvlogOptions } from "./src/server/evlog.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { mountProductionApp } from "./tests/support/production-app.ts";

__setDevMode(false);
const { app, instance } = await mountProductionApp({
  buildId: "uninitialized-logger",
  pages: [],
  root: defineRootRoute().config({ mode: "ssr" }).layout(({ children }) => children),
});
const { promise: emitted, resolve } = Promise.withResolvers();
setFurinEvlogOptions(instance, { drain: ({ event }) => { resolve(event); } });
app.get("/probe", ({ log }) => {
  log.set({ marker: "uninitialized" });
  return "ok";
});
const response = await app.handle(new Request("http://localhost/probe"));
assert.equal(response.status, 200);
assert.equal(await response.text(), "ok");
assert.equal((await emitted).marker, "uninitialized");
process.stdout.write("logger-active");
`,
    ],
    { cwd: join(import.meta.dir, "../../.."), env: { NODE_ENV: "production" }, timeoutMs: 10_000 }
  );

  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("logger-active");
});
