import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /[\\/]tests(?:[\\/].*)?$/;

test("nested Elysia prefixes preserve Furin rendering and navigation", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin, isFurinPageRequest } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";

const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  writeAppFile(fixture.path, "src/pages/not-found.tsx", 'export default () => <main>Nested missing</main>;');
  const app = new Elysia({ prefix: "/outer" }).request(({ request }) =>
    request.headers.has("x-deny") && isFurinPageRequest(request, "/admin")
      ? new Response("Blocked", { status: 403 }) : undefined
  ).use(
    new Elysia({ prefix: "/inner" }).use(
      await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin" })
    )
  );
  const response = await app.handle("/outer/inner/admin");
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("Home page");
  expect(html).toContain('name="furin-base-path" content="/outer/inner/admin"');
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
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("a failed async Elysia plugin prevents Furin dispatch", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp } from "./tests/support/app-fixtures.ts";
const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  let rejectPlugin;
  let dispatched = 0;
  const app = new Elysia().use(await furin({ pagesDir: join(fixture.path, "src/pages") }))
    .get("/probe", () => { dispatched++; return "unexpected"; })
    .use(new Promise((resolve, reject) => { rejectPlugin = reject; }));
  const pending = app.handle("/probe");
  rejectPlugin(new Error("plugin initialization failed"));
  await expect(pending).rejects.toThrow("plugin initialization failed");
  await expect(app.handle("/probe")).rejects.toThrow("plugin initialization failed");
  await expect(app.fetch(new Request("http://localhost/probe"))).rejects.toThrow("plugin initialization failed");
  expect(dispatched).toBe(0);
} finally {
  process.chdir(originalCwd);
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).toContain("plugin initialization failed");
  expect(proc.exitCode).toBe(0);
});

test("reusing a Furin plugin initializes independent loader caches and devtools streams", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      String.raw`
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";

const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  writeAppFile(fixture.path, "src/pages/index.tsx", [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    'export const route = defineRoute().config({ layout: rootRoute, mode: "ssg" })',
    '.loader(() => ({ call: globalThis.furinReuseCalls = (globalThis.furinReuseCalls ?? 0) + 1 }))',
    '.page(({ call }) => <main>{call}</main>);',
  ].join("\n"));
  const events = [];
  const emissions = [];
  const plugin = await furin({
    pagesDir: join(fixture.path, "src/pages"), prefix: "/admin",
    logger: { drain: ({ event }) => events.push(event), waitUntil: (task) => emissions.push(task) },
  });
  const first = new Elysia({ prefix: "/one" }).use(plugin);
  const second = new Elysia({ prefix: "/two" }).use(plugin);
  for (const [app, prefix, call] of [[first, "/one/admin", 1], [second, "/two/admin", 3]]) {
    const response = await app.handle(prefix);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('<main>' + call + '</main>');
    const data = await app.handle(prefix + "/_furin/data?path=%2F");
    expect(data.status).toBe(200);
    expect(await data.text()).toContain(prefix);
    const snapshot = await app.handle(new Request("http://localhost" + prefix + "/_furin/devtools/snapshot"));
    expect(snapshot.status).toBe(200);
    const body = await snapshot.text();
    expect(body).toContain(prefix);
    expect(body).not.toContain(prefix === "/one/admin" ? "/two/admin" : "/one/admin");
  }
  await Promise.all(emissions);
  expect(events.some(event => event.path === "/one/admin")).toBe(true);
  expect(events.some(event => event.path === "/two/admin")).toBe(true);
  expect(events.some(event => event.path.includes("/_furin/devtools/"))).toBe(false);
} finally {
  process.chdir(originalCwd);
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("reusing an Elysia container preserves independent Furin runtimes and child guards", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      String.raw`
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";
const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  writeAppFile(fixture.path, "src/pages/index.tsx", [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "./root";',
    'export const route = defineRoute().config({ layout: rootRoute, mode: "ssg" })',
    '.loader(() => ({ call: globalThis.furinContainerCalls = (globalThis.furinContainerCalls ?? 0) + 1 }))',
    '.page(({ call }) => <main>{call}</main>);',
  ].join("\n"));
  writeAppFile(fixture.path, "src/pages/files/[slug].tsx", [
    'import { defineRoute } from "@teyik0/furin";',
    'import { route as rootRoute } from "../root";',
    'export const route = defineRoute().config({ layout: rootRoute, mode: "ssr" })',
    '.loader(({ params }) => params).page(({ slug }) => <main>{slug}</main>);',
  ].join("\n"));
  const events = [];
  const emissions = [];
  const legacy = { handles: new WeakMap(), owners: new WeakMap(), wrappers: new WeakSet() };
  for (const property of ["fetch", "handle"]) {
    const descriptor = Object.getOwnPropertyDescriptor(Elysia.prototype, property);
    Object.defineProperty(Elysia.prototype, property, { ...descriptor, get() {
      const wrappers = Reflect.get(this, "~ext")?.hoc;
      const owned = wrappers?.some(wrapper => legacy.wrappers.has(wrapper));
      if (owned) legacy.owners.set(wrappers, this);
      const original = descriptor.get.call(this);
      if (property === "handle" && owned) {
        let handle = legacy.handles.get(this);
        if (!handle) {
          handle = (...args) => original(...args);
          legacy.handles.set(this, handle);
        }
        return handle;
      }
      return original;
    }});
  }
  Object.defineProperty(Elysia.prototype, Symbol.for("@teyik0/furin/elysia-owner-bindings"), { value: legacy });
  const child = new Elysia().beforeHandle(({ request }) =>
    request.headers.has("x-deny") ? new Response("Blocked", { status: 403 }) : undefined
  ).use(await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin",
    logger: { sampling: { rates: { info: 100 } }, drain: ({ event }) => events.push(event), waitUntil: task => emissions.push(task) },
  }));
  const one = new Elysia({ prefix: "/one" }).use(child);
  const two = new Elysia({ prefix: "/two" }).use(child);
  const { getFurinEvlogOptions } = await import("./src/server/evlog.ts");
  for (const app of [one, two]) app.get("/admin/options", () => getFurinEvlogOptions());
  for (const [slug, decoded] of [["100%", "100%"], ["50%off", "50%off"], ["%E0%A4%A", "%E0%A4%A"], ["100%25", "100%"]]) {
    const logical = "/files/" + slug;
    const page = await one.handle("/one/admin" + logical);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("<main>" + decoded + "</main>");
    const data = await one.handle("/one/admin/_furin/data?path=" + encodeURIComponent(logical));
    expect(data.status).toBe(200);
    expect(await data.text()).toContain('"slug":' + JSON.stringify(decoded));
  }
  for (const [app, prefix] of [[one, "/one/admin"], [two, "/two/admin"]]) {
    const options = await app.handle(prefix + "/options");
    expect(options.status).toBe(200);
    expect(await options.json()).not.toHaveProperty("sampling");
  }
  for (const [app, prefix, call] of [[one, "/one/admin", 1], [two, "/two/admin", 2], [one, "/one/admin", 1]]) {
    const response = await app.handle(prefix);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("<main>" + call + "</main>");
    expect(html).toContain('name="furin-base-path" content="' + prefix + '"');
    for (const path of [prefix, prefix + "/_furin/data?path=%2F"]) {
      expect((await app.handle(new Request("http://localhost" + path, { headers: { "x-deny": "1" } }))).status).toBe(403);
    }
  }
  for (const [app, prefix] of [[one, "/one/admin"], [two, "/two/admin"], [one, "/one/admin"]]) {
    const data = await app.fetch(new Request("http://localhost" + prefix + "/_furin/data?path=%2F"));
    expect(data.status).toBe(200);
    expect(await data.text()).toContain(prefix);
    const snapshot = await app.handle(new Request("http://localhost" + prefix + "/_furin/devtools/snapshot"));
    expect(snapshot.status).toBe(200);
    const body = await snapshot.text();
    expect(body).toContain(prefix);
    expect(body).not.toContain(prefix === "/one/admin" ? "/two/admin" : "/one/admin");
  }
  await Promise.all(emissions);
  expect(events.filter(event => event.path === "/one/admin").length).toBe(6);
  expect(events.filter(event => event.path === "/two/admin").length).toBe(3);
} finally {
  process.chdir(originalCwd);
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("sibling Furin mounts emit once through their own logging drain", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp } from "./tests/support/app-fixtures.ts";
const fixture = createTmpApp("cli-app");
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
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("one final Elysia app can mount a reused container at two nested prefixes", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp } from "./tests/support/app-fixtures.ts";

const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const plugin = await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin" });
  const child = new Elysia().use(plugin);
  const app = new Elysia({ prefix: "/outer" })
    .use(new Elysia({ prefix: "/left" }).use(child))
    .use(new Elysia({ prefix: "/right" }).use(child));
  const detached = app.handle;
  expect(app.handle).toBe(detached);
  const detachedFetch = app.fetch;
  expect(app.fetch).toBe(detachedFetch);
  for (const prefix of ["/outer/left/admin", "/outer/right/admin"]) {
    const response = await detached(prefix);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("Home page");
    expect(html).toContain('name="furin-base-path" content="' + prefix + '"');
    const data = await app.fetch(new Request("http://localhost" + prefix + "/_furin/data?path=%2F"));
    expect(data.status).toBe(200);
    expect(await data.text()).toContain(prefix);
  }
} finally {
  process.chdir(originalCwd);
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("unreferenced applications release their Furin runtime and development graph", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { allInstances } from "./src/server/instance.ts";
import { devGraph, developmentGraphs } from "./src/server/dev/graph.ts";
import { createTmpApp } from "./tests/support/app-fixtures.ts";

const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const pagesDir = join(fixture.path, "src/pages").replaceAll("\\\\", "/");
  async function releaseApp() {
    const app = new Elysia().use(await furin({ pagesDir }));
    const instance = allInstances().find(instance => instance.pagesDir === pagesDir);
    expect(instance).toBeDefined();
    return { app: new WeakRef(app), instance: new WeakRef(instance), graph: new WeakRef(devGraph(instance)) };
  }
  const released = await releaseApp();
  for (let attempt = 0; attempt < 5; attempt++) {
    await Bun.sleep(0);
    Bun.gc(true);
  }
  expect(released.app.deref() === undefined).toBe(true);
  expect(released.instance.deref() === undefined).toBe(true);
  expect(released.graph.deref() === undefined).toBe(true);
  expect(allInstances().some(instance => instance.pagesDir === pagesDir)).toBe(false);
  expect(developmentGraphs().some(graph => graph.snapshot?.root.path.replaceAll("\\\\", "/").startsWith(pagesDir))).toBe(false);
} finally {
  process.chdir(originalCwd);
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
});

test("reused containers keep independent browser streams and watchers when one server stops", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      String.raw`
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "./src/furin.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";

const fixture = createTmpApp("cli-app");
const originalCwd = process.cwd();
const apps = [];
const sockets = [];
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const plugin = await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin" });
  const child = new Elysia().use(plugin);
  const messages = [[], []];
  for (const prefix of ["/one", "/two"]) {
    const app = new Elysia({ prefix }).use(child).listen({ hostname: "127.0.0.1", port: 0 });
    apps.push(app);
    expect((await fetch(new URL(prefix + "/admin/_furin/data?path=%2F", app.server.url))).status).toBe(200);
    const socket = new WebSocket("ws://127.0.0.1:" + app.server.port + prefix + "/admin/_furin/events");
    const inbox = messages[apps.length - 1];
    socket.addEventListener("message", event => inbox.push(JSON.parse(event.data)));
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
  }
  for (const [index, prefix] of [[0, "/one"], [1, "/two"]]) {
    await fetch(new URL(prefix + "/admin/_furin/data?path=%2F", apps[index].server.url));
  }
  const eventDeadline = Date.now() + 2000;
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
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const response = await fetch(url);
      if (response.status === 200) {
        expect(await response.text()).toContain('"added":true');
        return;
      }
      await Bun.sleep(25);
    }
    throw new Error("Topology did not update for " + prefix + "/" + name);
  }
  addPage("added");
  await Promise.all([waitForPage(apps[0], "/one", "added"), waitForPage(apps[1], "/two", "added")]);
  await apps.pop().stop(true);
  addPage("after-stop");
  await waitForPage(apps[0], "/one", "after-stop");
} finally {
  for (const socket of sockets) socket.close();
  for (const app of apps) await app.stop(true);
  process.chdir(originalCwd);
  fixture.cleanup();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });
  expect(new TextDecoder().decode(proc.stderr)).not.toContain("error:");
  expect(proc.exitCode).toBe(0);
}, 10_000);
