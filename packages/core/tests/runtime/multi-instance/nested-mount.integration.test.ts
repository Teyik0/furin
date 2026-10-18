import { expect, test } from "bun:test";
import { createTmpApp } from "../../support/app-fixtures.ts";
import { startProcess } from "../../support/process.ts";

const TESTS_DIR_SUFFIX_RE = /[\\/]tests(?:[\\/].*)?$/;

async function runFixtureScript(
  source: string,
  timeoutMs: number
): Promise<{ exitCode: number; stderr: string }> {
  // Owned by the parent so it is removed even when the child is killed.
  const fixture = createTmpApp("cli-app");
  const proc = startProcess([process.execPath, "-e", source], {
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    env: {
      FURIN_TEST_FIXTURE_DEADLINE: String(Date.now() + timeoutMs - 500),
      FURIN_TEST_FIXTURE_PATH: fixture.path,
    },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      proc.exitCode,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          proc.kill();
          reject(new Error(`Fixture process timed out.\n${proc.getStdout()}\n${proc.getStderr()}`));
        }, timeoutMs);
      }),
    ]);
    return { exitCode, stderr: proc.getStderr() || proc.getStdout() };
  } finally {
    clearTimeout(timer);
    proc.kill();
    await proc.exitCode;
    fixture.cleanup();
  }
}

test("nested Elysia containers serve a declared full prefix", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin, isFurinPageRequest } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { writeAppFile } from "./tests/support/app-fixtures.ts";

const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  writeAppFile(fixture.path, "src/pages/not-found.tsx", 'export default () => <main>Nested missing</main>;');
  const app = new Elysia().onRequest(({ request }) =>
    request.headers.has("x-deny") && isFurinPageRequest(request, "/outer/inner/admin")
      ? new Response("Blocked", { status: 403 }) : undefined
  ).use(
    new Elysia().use(
      await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/outer/inner/admin" })
    )
  );
  const response = await app.handle("/outer/inner/admin");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Home page");
  const data = await app.handle("/outer/inner/admin/_furin/data?path=%2F");
  expect(data.status).toBe(200);
  expect(data.headers.get("content-type")).toContain("json");
  for (const path of ["/outer/inner/admin", "/outer/inner/admin/_furin/data?path=%2F"]) {
    const denied = await app.handle(new Request("http://localhost" + path, { headers: { "x-deny": "1" } }));
    expect(denied.status).toBe(403);
  }
  const missing = await app.handle("/outer/inner/admin/absent");
  expect(missing.status).toBe(404);
  expect(await missing.text()).toContain("Nested missing");
  app.compile();
  const detached = app.fetch;
  expect((await detached(new Request("http://localhost/outer/inner/admin"))).status).toBe(200);
  const plain = new Elysia().get("/", () => "plain");
  expect(plain.fetch).toBe(plain.fetch);
  expect(await (await plain.handle("/")).text()).toBe("plain");
} finally {
  process.chdir(originalCwd);
}
`,
    8000
  );
  expect(proc.stderr).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("mounting and serving Furin leaves Elysia's prototype untouched", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";

const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
const descriptors = () => ["fetch", "handle"].map((name) => Object.getOwnPropertyDescriptor(Elysia.prototype, name)?.get);
const before = descriptors();
const symbols = Object.getOwnPropertySymbols(Elysia.prototype);
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const app = new Elysia().use(await furin({ pagesDir: join(fixture.path, "src/pages") }));
  expect((await app.handle("/")).status).toBe(200);
  expect((await app.fetch(new Request("http://localhost/"))).status).toBe(200);
  expect(descriptors()).toEqual(before);
  expect(Object.getOwnPropertySymbols(Elysia.prototype)).toEqual(symbols);
} finally {
  process.chdir(originalCwd);
}
`,
    8000
  );
  expect(proc.stderr).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("a prefix the parent composition does not match fails at startup", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";

const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
const failures = [];
const consoleError = console.error;
console.error = (...args) => failures.push(args.map(String).join(" "));
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const app = new Elysia({ prefix: "/outer" }).use(
    new Elysia({ prefix: "/inner" }).use(
      await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin" })
    )
  );
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const deadline = Date.now() + 3000;
  while (failures.length === 0 && Date.now() < deadline) await Bun.sleep(10);
  console.error = consoleError;
  const failure = failures.join("\\n");
  expect(failure).toContain('furin({ prefix: "/admin" }) is served at "/outer/inner/admin"');
  expect(failure).toContain('repeat the parent prefix in furin({ prefix: "/outer/inner/admin" })');
  expect(app.server).toBeUndefined();
  // Elysia reports a failed listen() through the exit code.
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
} finally {
  console.error = consoleError;
  process.chdir(originalCwd);
}
`,
    8000
  );
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr);
  }
});

test("one furin() plugin cannot serve two applications", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";

const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
const failures = [];
const consoleError = console.error;
console.error = (...args) => failures.push(args.map(String).join(" "));
const apps = [];
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const plugin = await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin" });
  new Elysia().use(plugin);
  expect(() => new Elysia().use(plugin)).toThrow("call furin() again");

  // Reusing a container that already holds the plugin shares one runtime.
  const container = new Elysia().use(
    await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/shared" })
  );
  for (const _ of [0, 1]) {
    apps.push(new Elysia().use(container).listen({ hostname: "127.0.0.1", port: 0 }));
  }
  const deadline = Date.now() + 3000;
  while (failures.length === 0 && Date.now() < deadline) await Bun.sleep(10);
  console.error = consoleError;
  expect(failures.join("\\n")).toContain("call furin() again");
  expect(process.exitCode).toBe(1);
  process.exitCode = 0;
} finally {
  for (const app of apps) await app.stop(true);
  console.error = consoleError;
  process.chdir(originalCwd);
}
`,
    8000
  );
  if (proc.exitCode !== 0) {
    throw new Error(proc.stderr);
  }
});

test("fetch waits for async plugins and continues serving after they settle and compile", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  let resolvePlugin;
  const app = new Elysia().use(await furin({ pagesDir: join(fixture.path, "src/pages"), logger: { drain: () => undefined } }))
    .use(new Promise(resolve => { resolvePlugin = resolve; }));
  const fetch = app.fetch;
  let served = false;
  const pending = fetch(new Request("http://localhost/async")).then(response => { served = true; return response; });
  await Bun.sleep(0);
  expect(served).toBe(false);
  resolvePlugin(new Elysia().get("/async", () => "settled"));
  expect(await (await pending).text()).toBe("settled");
  await app.modules;
  app.compile();
  for (const path of ["/async", "/", "/async", "/"]) {
    const response = await fetch(new Request("http://localhost" + path));
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(path === "/async" ? "settled" : "Home page");
  }
} finally {
  process.chdir(originalCwd);
}
`,
    8000
  );
  expect(proc.stderr).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("sibling Furin mounts emit once through their own logging drain", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const first = [];
  const second = [];
  const emissions = [];
  const app = new Elysia()
    .use(await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/one",
      logger: { drain: ({ event }) => first.push(event), waitUntil: task => emissions.push(task) } }))
    .use(await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/two",
      logger: { drain: ({ event }) => second.push(event), waitUntil: task => emissions.push(task) } }))
    .get("/api", ({ log }) => { log.set({ parent: true }); return "parent"; });
  for (const prefix of ["/one", "/two"]) {
    expect((await app.handle(prefix)).status).toBe(200);
    const data = await app.handle(prefix + "/_furin/data?path=%2F");
    expect(data.status).toBe(200);
    await data.text();
  }
  expect(await (await app.handle("/api")).text()).toBe("parent");
  await Promise.all(emissions);
  expect(first.filter(event => event.path === "/one").length).toBe(1);
  expect(second.filter(event => event.path === "/two").length).toBe(1);
  expect(first.filter(event => event.path === "/").length).toBe(1);
  expect(second.filter(event => event.path === "/").length).toBe(1);
  expect(first.some(event => event.path === "/two")).toBe(false);
  expect(second.some(event => event.path === "/one")).toBe(false);
  expect([...first, ...second].filter(event => event.path === "/api").length).toBe(1);
  expect([...first, ...second]).toHaveLength(5);
} finally {
  process.chdir(originalCwd);
}
`,
    8000
  );
  expect(proc.stderr).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("unreferenced applications release their Furin runtime and development graph", async () => {
  const proc = await runFixtureScript(
    `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { allInstances } from "./src/server/instance.ts";
import { devGraph, developmentGraphs } from "./src/server/dev/graph.ts";

const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const pagesDir = join(fixture.path, "src/pages").replaceAll("\\\\", "/");
  async function collected(references, timeout) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      await Bun.sleep(10);
      Bun.gc(true);
      if (references.every(reference => reference.deref() === undefined)) return true;
    }
    return false;
  }
  const held = new Elysia();
  expect(await collected([new WeakRef(held)], 50)).toBe(false);
  expect(held).toBeDefined();
  async function releaseApp() {
    const app = new Elysia().use(await furin({ pagesDir }));
    await app.modules;
    const instance = allInstances().find(instance => instance.pagesDir === pagesDir);
    expect(instance).toBeDefined();
    return { app: new WeakRef(app), instance: new WeakRef(instance), graph: new WeakRef(devGraph(instance)) };
  }
  const released = await releaseApp();
  expect(await collected([released.app, released.instance, released.graph], 2000)).toBe(true);
  expect(released.app.deref() === undefined).toBe(true);
  expect(released.instance.deref() === undefined).toBe(true);
  expect(released.graph.deref() === undefined).toBe(true);
  expect(allInstances().some(instance => instance.pagesDir === pagesDir)).toBe(false);
  expect(developmentGraphs().some(graph => graph.snapshot?.root.path.replaceAll("\\\\", "/").startsWith(pagesDir))).toBe(false);
} finally {
  process.chdir(originalCwd);
}
`,
    8000
  );
  expect(proc.stderr).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("runtimes keep independent browser streams and watchers when one server stops", async () => {
  const proc = await runFixtureScript(
    String.raw`
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { writeAppFile } from "./tests/support/app-fixtures.ts";

const fixture = { path: process.env.FURIN_TEST_FIXTURE_PATH };
const originalCwd = process.cwd();
const apps = [];
const sockets = [];
const fixtureDeadline = Number(process.env.FURIN_TEST_FIXTURE_DEADLINE);
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const messages = [[], []];
  for (const prefix of ["/one", "/two"]) {
    const plugin = await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: prefix + "/admin" });
    const app = new Elysia().use(new Elysia().use(plugin)).listen({ hostname: "127.0.0.1", port: 0 });
    apps.push(app);
    const initial = await fetch(new URL(prefix + "/admin/_furin/data?path=%2F", app.server.url));
    expect(initial.status).toBe(200);
    await initial.text();
    console.log("[fixture] server rendered " + prefix);
    const socket = new WebSocket("ws://127.0.0.1:" + app.server.port + prefix + "/admin/_furin/events");
    const inbox = messages[apps.length - 1];
    socket.addEventListener("message", event => inbox.push(JSON.parse(event.data)));
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    console.log("[fixture] browser stream opened " + prefix);
  }
  for (const [index, prefix] of [[0, "/one"], [1, "/two"]]) {
    const response = await fetch(new URL(prefix + "/admin/_furin/data?path=%2F", apps[index].server.url));
    await response.text();
  }
  const eventDeadline = Math.min(fixtureDeadline, Date.now() + 2000);
  while (Date.now() < eventDeadline && messages.some(inbox => !inbox.some(event => JSON.stringify(event).includes("/admin")))) await Bun.sleep(10);
  for (const [index, prefix, sibling] of [[0, "/one/admin", "/two/admin"], [1, "/two/admin", "/one/admin"]]) {
    expect(JSON.stringify(messages[index])).toContain(prefix);
    expect(JSON.stringify(messages[index])).not.toContain(sibling);
  }
  function addPage(name) {
    writeAppFile(fixture.path, "src/pages/" + name + ".tsx", [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      'export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" })',
      '.loader(() => ({ added: true })).page(() => <main>Added</main>);',
    ].join("\n"));
  }
  async function waitForPage(app, prefix, name) {
    const url = new URL(prefix + "/admin/_furin/data?path=%2F" + name, app.server.url);
    const deadline = Math.min(fixtureDeadline, Date.now() + 4000);
    while (Date.now() < deadline) {
      const response = await fetch(url);
      if (response.status === 200) {
        expect(await response.text()).toContain('"added":true');
        return;
      }
      await response.body?.cancel();
      await Bun.sleep(25);
    }
    throw new Error("Topology did not update for " + prefix + "/" + name);
  }
  addPage("added");
  await Promise.all([waitForPage(apps[0], "/one", "added"), waitForPage(apps[1], "/two", "added")]);
  console.log("[fixture] both watchers updated");
  await apps.pop().stop(true);
  console.log("[fixture] second server stopped");
  addPage("after-stop");
  await waitForPage(apps[0], "/one", "after-stop");
  console.log("[fixture] first watcher updated after sibling stopped");
} finally {
  for (const app of apps) await app.stop(true);
  await Promise.all(sockets.map(socket => new Promise(resolve => {
    if (socket.readyState === WebSocket.CLOSED) return resolve();
    socket.addEventListener("close", resolve, { once: true });
    socket.close();
  })));
  console.log("[fixture] all servers and sockets closed");
  process.chdir(originalCwd);
}
`,
    9500
  );
  expect(proc.stderr).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
}, 10_000);
