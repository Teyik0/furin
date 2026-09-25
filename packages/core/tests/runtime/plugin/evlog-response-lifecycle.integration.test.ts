import { expect, test } from "bun:test";
import { join } from "node:path";

test("a regular response returns before its wide event is emitted", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { Elysia } from "elysia";
import { createFurinEvlog } from "./src/server/evlog.ts";

const events = [];
const { promise: emitted, resolve: markEmitted } = Promise.withResolvers();
const app = new Elysia()
  .use(createFurinEvlog({ drain: ({ event }) => { events.push(event); markEmitted(); } }))
  .get("/", ({ log }) => {
    log.set({ marker: "response-lifecycle" });
    return "ok";
  });

const response = await app.handle(new Request("http://localhost/"));
const beforeBody = events.length;
const body = await response.text();
await emitted;
process.stdout.write("__RESULT__" + JSON.stringify({
  beforeBody,
  body,
  events: events.length,
  marker: events[0]?.marker,
  status: events[0]?.status,
}));
`,
    ],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = result.stdout.toString();
  const marker = output.lastIndexOf("__RESULT__");
  expect(marker).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(output.slice(marker + "__RESULT__".length))).toEqual({
    beforeBody: 0,
    body: "ok",
    events: 1,
    marker: "response-lifecycle",
    status: 200,
  });
});

test("registers the full deferred emission with waitUntil before returning", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { Elysia } from "elysia";
import { createFurinEvlog, setRuntimeEvlogWaitUntil } from "./src/server/evlog.ts";

const events = [];
const pending = [];
setRuntimeEvlogWaitUntil((promise) => { pending.push(promise); });
const app = new Elysia()
  .use(createFurinEvlog({
    drain: ({ event }) => { events.push(event); },
  }))
  .get("/", () => "ok");

const response = await app.handle(new Request("http://localhost/"));
const registeredBeforeReturn = pending.length;
const emittedBeforeReturn = events.length;
await Promise.all(pending);
process.stdout.write("__RESULT__" + JSON.stringify({
  body: await response.text(),
  emittedBeforeReturn,
  events: events.length,
  registeredBeforeReturn,
}) + "__END__");
`,
    ],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = result.stdout.toString();
  const marker = output.lastIndexOf("__RESULT__");
  expect(marker).toBeGreaterThanOrEqual(0);
  expect(
    JSON.parse(output.slice(marker + "__RESULT__".length, output.indexOf("__END__", marker)))
  ).toEqual({
    body: "ok",
    emittedBeforeReturn: 0,
    events: 1,
    registeredBeforeReturn: 1,
  });
});

test("a streaming response emits its wide event only after the body finishes", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { Elysia } from "elysia";
import { createFurinEvlog } from "./src/server/evlog.ts";

const events = [];
const { promise: emitted, resolve: markEmitted } = Promise.withResolvers();
const app = new Elysia()
  .use(createFurinEvlog({ drain: ({ event }) => { events.push(event); markEmitted(); } }))
  .get("/stream", () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("first"));
      setTimeout(() => {
        controller.enqueue(new TextEncoder().encode("second"));
        controller.close();
      }, 10);
    },
  }), { headers: { "content-type": "text/event-stream" } }));

const response = await app.handle(new Request("http://localhost/stream"));
const beforeBody = events.length;
const reader = response.body.getReader();
const first = await reader.read();
const afterFirst = events.length;
const second = await reader.read();
await reader.read();
const body = new TextDecoder().decode(first.value) + new TextDecoder().decode(second.value);
await emitted;
process.stdout.write("__RESULT__" + JSON.stringify({
  afterFirst,
  beforeBody,
  body,
  events: events.length,
  status: events[0]?.status,
}));
`,
    ],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = result.stdout.toString();
  const marker = output.lastIndexOf("__RESULT__");
  expect(marker).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(output.slice(marker + "__RESULT__".length))).toEqual({
    afterFirst: 0,
    beforeBody: 0,
    body: "firstsecond",
    events: 1,
    status: 200,
  });
});

test("a failed request emits one wide event with its HTTP status", () => {
  const result = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { Elysia } from "elysia";
import { createFurinEvlog } from "./src/server/evlog.ts";

const events = [];
const { promise: emitted, resolve: markEmitted } = Promise.withResolvers();
const app = new Elysia()
  .use(createFurinEvlog({ drain: ({ event }) => { events.push(event); markEmitted(); } }))
  .get("/error", () => { throw new Error("boom"); });

const response = await app.handle(new Request("http://localhost/error"));
const beforeBody = events.length;
await response.text();
await emitted;
process.stdout.write("__RESULT__" + JSON.stringify({
  beforeBody,
  events: events.length,
  responseStatus: response.status,
  status: events[0]?.status,
}));
`,
    ],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 30_000,
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  const output = result.stdout.toString();
  const marker = output.lastIndexOf("__RESULT__");
  expect(marker).toBeGreaterThanOrEqual(0);
  expect(JSON.parse(output.slice(marker + "__RESULT__".length))).toEqual({
    beforeBody: 0,
    events: 1,
    responseStatus: 500,
    status: 500,
  });
});
