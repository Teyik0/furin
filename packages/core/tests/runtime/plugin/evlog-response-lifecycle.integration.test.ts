import { expect, test } from "bun:test";
import { join } from "node:path";

async function runFixture(source: string) {
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", source],
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, NODE_ENV: "test" },
    stderr: "pipe",
    stdout: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("a regular response returns before its wide event is emitted", async () => {
  const result = await runFixture(`
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
`);

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

test("registers the full deferred emission with waitUntil before returning", async () => {
  const result = await runFixture(`
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
`);

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

test("a streaming response emits its wide event only after the body finishes", async () => {
  const result = await runFixture(`
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
`);

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

test("a failed request emits one wide event with its HTTP status", async () => {
  const result = await runFixture(`
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
`);

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

test("request logging selects the owning instance's drain", async () => {
  const result = await runFixture(`
import { Elysia } from "elysia";
import { createFurinEvlog, setFurinEvlogOptions } from "./src/server/evlog.ts";
import { createInstance, runWithInstanceScope } from "./src/server/instance.ts";
const a = createInstance("/a", "a");
const b = createInstance("/b", "b");
const events = { a: [], b: [] };
const pending = [];
const optionsA = { drain: ({ event }) => events.a.push(event), waitUntil: promise => pending.push(promise) };
const optionsB = { drain: ({ event }) => events.b.push(event), waitUntil: promise => pending.push(promise) };
setFurinEvlogOptions(a, optionsA);
setFurinEvlogOptions(b, optionsB);
const app = new Elysia().use(createFurinEvlog(optionsA)).get("/a", () => "a").get("/b", () => "b");
await Promise.all([a, b].map(instance => runWithInstanceScope(instance, () => app.handle(new Request("http://localhost" + instance.prefix)))));
await Promise.all(pending);
process.stdout.write("__RESULT__" + JSON.stringify({ a: events.a.map(event => event.path), b: events.b.map(event => event.path) }));
`);
  expect(result.exitCode, result.stderr).toBe(0);
  const output = result.stdout;
  expect(JSON.parse(output.slice(output.lastIndexOf("__RESULT__") + "__RESULT__".length))).toEqual({
    a: ["/a"],
    b: ["/b"],
  });
});

test("synthetic rendering returns while its log drain remains tracked", async () => {
  const result = await runFixture(`
import { setFurinEvlogOptions, setRuntimeEvlogWaitUntil } from "./src/server/evlog.ts";
import { createInstance, withInstance } from "./src/server/instance.ts";
import { runInSyntheticRenderScope } from "./src/server/context-logger.ts";
const instance = createInstance("/admin", "admin");
const gate = Promise.withResolvers();
const pending = [];
setRuntimeEvlogWaitUntil(promise => pending.push(promise));
setFurinEvlogOptions(instance, { drain: () => gate.promise });
let rendered = false;
const render = withInstance(instance, () => runInSyntheticRenderScope(() => "rendered", { route: "/" })).then(() => { rendered = true; });
await Bun.sleep(25);
const beforeDrain = rendered;
const tracked = pending.length;
gate.resolve();
await render;
await Promise.all(pending);
process.stdout.write("__RESULT__" + JSON.stringify({ beforeDrain, tracked }));
`);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(
    JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("__RESULT__") + "__RESULT__".length))
  ).toEqual({ beforeDrain: true, tracked: 1 });
});

test("a failed synthetic log drain preserves render results and original errors", async () => {
  const result = await runFixture(`
import { setFurinEvlogOptions } from "./src/server/evlog.ts";
import { createInstance, withInstance } from "./src/server/instance.ts";
import { runInSyntheticRenderScope } from "./src/server/context-logger.ts";
const instance = createInstance("/admin", "admin");
let emissions = 0;
const pending = [];
setFurinEvlogOptions(instance, { drain: () => { emissions++; return Promise.reject(new Error("drain unavailable")); }, waitUntil: promise => pending.push(promise) });
const rendered = await withInstance(instance, () => runInSyntheticRenderScope(() => "rendered", { route: "/" }));
const original = new Error("loader failure");
let retained = false;
try {
  await withInstance(instance, () => runInSyntheticRenderScope(() => { throw original; }, { route: "/" }));
} catch (error) { retained = error === original; }
await Promise.all(pending);
process.stdout.write("__RESULT__" + JSON.stringify({ rendered, retained, emissions }));
`);
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toContain("[evlog] drain failed:");
  expect(
    JSON.parse(result.stdout.slice(result.stdout.lastIndexOf("__RESULT__") + "__RESULT__".length))
  ).toEqual({ rendered: "rendered", retained: true, emissions: 2 });
});

test("synthetic rendering applies its instance's drain, redaction and enrichment", async () => {
  const result = await runFixture(`
import { setFurinEvlogOptions } from "./src/server/evlog.ts";
import { createInstance, withInstance } from "./src/server/instance.ts";
import { getLogger, runInSyntheticRenderScope } from "./src/server/context-logger.ts";
const instance = createInstance("/admin", "admin");
const events = [];
const pending = [];
setFurinEvlogOptions(instance, {
  waitUntil: promise => pending.push(promise),
  drain: ({ event }) => events.push(event),
  redact: { paths: ["secret"] },
  enrich: ({ event }) => { event.owner = "admin"; },
});

await withInstance(instance, () => runInSyntheticRenderScope(() => getLogger().set({ secret: "hidden", marker: "synthetic" }), { route: "/dashboard", render: "isr" }));
await Promise.all(pending);
process.stdout.write("__RESULT__" + JSON.stringify({ count: events.length, marker: events[0]?.marker, owner: events[0]?.owner, leaked: JSON.stringify(events).includes("hidden") }));
`);
  expect(result.exitCode, result.stderr).toBe(0);
  const output = result.stdout;
  expect(JSON.parse(output.slice(output.lastIndexOf("__RESULT__") + "__RESULT__".length))).toEqual({
    count: 1,
    marker: "synthetic",
    owner: "admin",
    leaked: false,
  });
});

test("composed Furin applications log to the owning mount once", async () => {
  const result = await runFixture(`
import { Elysia } from "elysia";
import { join } from "node:path";
import { furin } from "./src/furin.ts";
import { createTmpApp } from "./tests/support/app-fixtures.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
const fixture = createTmpApp("cli-app");
const cwd = process.cwd();
const events = { a: [], b: [] };
const pending = [];
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const a = new Elysia().use(await furin({ prefix: "/a", pagesDir: join(fixture.path, "src/pages"), logger: { drain: ({ event }) => events.a.push(event), waitUntil: promise => pending.push(promise) } }));
  const b = new Elysia().use(await furin({ prefix: "/b", pagesDir: join(fixture.path, "src/pages"), logger: { drain: ({ event }) => events.b.push(event), waitUntil: promise => pending.push(promise) } }));
  const app = new Elysia().use(a).use(b);
  const responses = await Promise.all(["/a", "/b"].map(path => app.handle(new Request("http://localhost" + path))));
  await Promise.all(pending);
  process.stdout.write("__RESULT__" + JSON.stringify({ statuses: responses.map(response => response.status), a: events.a.map(event => event.path), b: events.b.map(event => event.path) }) + "__END__");
} finally {
  process.chdir(cwd);
  fixture.cleanup();
}
`);
  expect(result.exitCode, result.stderr).toBe(0);
  const start = result.stdout.lastIndexOf("__RESULT__") + "__RESULT__".length;
  expect(JSON.parse(result.stdout.slice(start, result.stdout.indexOf("__END__", start)))).toEqual({
    statuses: [200, 200],
    a: ["/a"],
    b: ["/b"],
  });
});
