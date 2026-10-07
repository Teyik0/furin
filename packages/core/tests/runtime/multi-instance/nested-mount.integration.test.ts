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

test("one final Elysia app can mount a reused plugin at two nested prefixes", () => {
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
  const app = new Elysia({ prefix: "/outer" })
    .use(new Elysia({ prefix: "/left" }).use(plugin))
    .use(new Elysia({ prefix: "/right" }).use(plugin));
  const detached = app.handle;
  expect(app.handle).toBe(detached);
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
  const pagesDir = join(fixture.path, "src/pages");
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
  expect(developmentGraphs().some(graph => graph.snapshot?.root.path.startsWith(pagesDir))).toBe(false);
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

test("reused plugins keep independent topology watchers when one server stops", () => {
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
try {
  process.chdir(fixture.path);
  __setDevMode(true);
  const plugin = await furin({ pagesDir: join(fixture.path, "src/pages"), prefix: "/admin" });
  for (const prefix of ["/one", "/two"]) {
    const app = new Elysia({ prefix }).use(plugin).listen({ hostname: "127.0.0.1", port: 0 });
    apps.push(app);
    expect((await fetch(new URL(prefix + "/admin/_furin/data?path=%2F", app.server.url))).status).toBe(200);
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
