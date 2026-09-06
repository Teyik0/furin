import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { evlogSetMock, resetEvlogMock } from "../../setup/evlog-mock";

const { furin } = await import("../../../src/furin");
const { __clearInstanceRegistry } = await import("../../../src/server/instance");
const { __setDevMode } = await import("../../../src/server/runtime-env");

const fixturesDir = join(import.meta.dir, "../../fixtures/pages/default");

async function createTestApp(clientLogging: boolean): Promise<Elysia> {
  return new Elysia().use(await furin({ clientLogging, pagesDir: fixturesDir }));
}

afterEach(() => {
  __clearInstanceRegistry();
  resetEvlogMock();
});

test.serial("browser log ingest is not mounted unless clientLogging is enabled", async () => {
  __setDevMode(true);

  const app = await createTestApp(false);
  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body: "[]",
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(res.status).toBe(404);
});

test.serial("dev inspector is not mounted by default", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  const response = await app.handle(
    new Request("http://localhost/__furin/_inspect/isr", { headers: { host: "attacker.test" } })
  );

  expect(response.status).toBe(404);
});

test.serial("native DevTools records correlated development requests", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  const pageResponse = await app.handle(new Request("http://localhost/ssr-page"));
  expect(pageResponse.status).toBe(200);

  const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const snapshot = await response.json();
  const pageEvents = snapshot.events.filter(
    (event: { path?: string }) => event.path === "/ssr-page"
  );

  expect(pageEvents.map((event: { type: string }) => event.type)).toEqual([
    "request.started",
    "request.finished",
  ]);
  expect(pageEvents[0]?.requestId).toBe(pageEvents[1]?.requestId);
});

test.serial("native DevTools does not record its own transport requests", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  const initial = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const before = await initial.json();
  await app.handle(new Request("http://localhost/_furin/devtools/client.js"));
  const stream = await app.handle(new Request("http://localhost/_furin/devtools/events"));
  await stream.body?.cancel();
  const final = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const after = await final.json();

  expect(after.events).toEqual(before.events);
});

test.serial("native DevTools records loader timings without loader values", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  const pageResponse = await app.handle(new Request("http://localhost/with-loader"));
  expect(pageResponse.status).toBe(200);

  const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const snapshot = await response.json();
  const loaderEvents = snapshot.events.filter(
    (event: { path?: string; type: string }) =>
      event.path === "/with-loader" && event.type === "loader.finished"
  );

  expect(loaderEvents.map((event: { loader: string }) => event.loader)).toEqual([
    "layout:0",
    "page",
  ]);
  expect(loaderEvents.every((event: { durationMs: number }) => event.durationMs >= 0)).toBe(true);
  expect(JSON.stringify(loaderEvents)).not.toContain("from-layout");
  expect(JSON.stringify(loaderEvents)).not.toContain("from-page");
});

test.serial("native DevTools includes synchronous work and throws in loader events", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  await app.handle(new Request("http://localhost/sync-loader"));
  await app.handle(new Request("http://localhost/sync-loader-error"));
  const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const snapshot = await response.json();
  const fulfilled = snapshot.events.find(
    (event: { path?: string; type: string }) =>
      event.path === "/sync-loader" && event.type === "loader.finished"
  );
  const rejected = snapshot.events.find(
    (event: { path?: string; type: string }) =>
      event.path === "/sync-loader-error" && event.type === "loader.finished"
  );

  expect(fulfilled).toMatchObject({ status: "fulfilled" });
  expect(fulfilled.durationMs).toBeGreaterThanOrEqual(7);
  expect(rejected).toMatchObject({ status: "rejected" });
});

test.serial("native DevTools records ISR cache hits and misses", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  await app.handle(new Request("http://localhost/isr-page"));
  await app.handle(new Request("http://localhost/isr-page"));
  const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const snapshot = await response.json();
  const cacheEvents = snapshot.events.filter(
    (event: { path?: string; type: string }) =>
      event.path === "/isr-page" && event.type === "cache.access"
  );

  expect(cacheEvents.map((event: { outcome: string }) => event.outcome)).toContain("miss");
  expect(cacheEvents.map((event: { outcome: string }) => event.outcome)).toContain("hit");
});

test.serial("native DevTools records serialized route payload bytes", async () => {
  __setDevMode(true);
  const app = await createTestApp(false);

  const dataResponse = await app.handle(
    new Request("http://localhost/_furin/data?path=/with-loader")
  );
  expect(dataResponse.status).toBe(200);
  await dataResponse.text();

  const response = await app.handle(new Request("http://localhost/_furin/devtools/snapshot"));
  const snapshot = await response.json();
  const payloadEvent = snapshot.events.find(
    (event: { path?: string; type: string }) =>
      event.path === "/with-loader" && event.type === "payload.serialized"
  );

  expect(payloadEvent).toMatchObject({ kind: "route-data" });
  expect(payloadEvent.bytes).toBeGreaterThan(0);
});

test.serial("browser log ingest accepts browser events when enabled", async () => {
  __setDevMode(true);

  const app = await createTestApp(true);
  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body: JSON.stringify([{ event: { msg: "browser log" } }]),
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(res.status).toBe(204);
  expect(evlogSetMock).toHaveBeenCalledWith({ msg: "browser log", service: "furin:browser" });
});

test.serial("browser log ingest rejects oversized batches", async () => {
  __setDevMode(true);

  const body = JSON.stringify([{ event: { msg: "x".repeat(65_536) } }]);
  const app = await createTestApp(true);
  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body,
      headers: {
        "content-length": String(new TextEncoder().encode(body).byteLength),
        "content-type": "application/json",
      },
      method: "POST",
    })
  );

  expect(res.status).toBe(413);
});

test.serial("browser log ingest stops reading an oversized chunked body", async () => {
  __setDevMode(true);
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
    pull(controller) {
      pulls += 1;
      controller.enqueue(new TextEncoder().encode("x".repeat(8192)));
      if (pulls === 20) {
        controller.close();
      }
    },
  });
  const app = await createTestApp(true);

  const res = await app.handle(
    new Request("http://localhost/_furin/ingest", {
      body: stream,
      headers: { "content-type": "application/json" },
      method: "POST",
    })
  );

  expect(res.status).toBe(413);
  expect(cancelled).toBe(true);
  expect(pulls).toBeLessThan(20);
});
