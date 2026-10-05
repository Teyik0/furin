import { expect, test } from "bun:test";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createTmpApp } from "../../core/tests/support/app-fixtures";
import { runCli } from "../../core/tests/support/process";

test("a relocated Furin app retains its factory guard across the separately bundled desktop host", async () => {
  const fixture = createTmpApp("cli-app");
  try {
    writeFileSync(
      join(fixture.path, "src/server.ts"),
      `import { furin } from "@teyik0/furin";
import { createDesktopApp } from ${JSON.stringify(resolve(import.meta.dir, "../src/server.ts"))};

const observed: string[] = [];
const lifecycle = { setup: 0, cleanup: 0, shutdown: 0 };
const app = createDesktopApp()
  .wrap((next) => (request, server) => {
    const path = new URL(request.url).pathname;
    observed.push(path);
    if (path === "/wrapper-shortcut") return new Response("wrapper", { status: 203 });
    return next(request, server);
  })
  .request(({ request }) => {
    const path = new URL(request.url).pathname;
    observed.push(path);
    if (path === "/request-shortcut") return new Response("request", { status: 201 });
  })
  .get("/constant", "constant")
  .get("/api/host", () => ({ host: true }))
  .setup(() => { lifecycle.setup += 1; })
  .cleanup(() => { lifecycle.cleanup += 1; })
  .use(await furin({ pagesDir: import.meta.dir + "/pages" }));

export const onShutdown = () => { lifecycle.shutdown += 1; };
export default Object.assign(app, {
  getObserved: () => observed,
  getLifecycle: () => lifecycle,
});
`
    );
    const page = join(fixture.path, "src/pages/index.tsx");
    writeFileSync(page, readFileSync(page, "utf8").replace('mode: "ssg"', 'mode: "ssr"'));
    writeFileSync(join(fixture.path, "public/portable.txt"), "portable desktop asset");
    const built = await runCli(["build", "--target", "bun", "--output", "app"], {
      cwd: fixture.path,
    });
    expect(built.exitCode, built.stderr + built.stdout).toBe(0);

    const relocated = join(fixture.path, "relocated");
    renameSync(join(fixture.path, ".furin/build/bun"), relocated);
    renameSync(join(fixture.path, "src"), join(fixture.path, "source-not-deployed"));
    renameSync(join(fixture.path, "public"), join(fixture.path, "public-not-deployed"));
    const hostSource = join(fixture.path, "desktop-host.ts");
    writeFileSync(
      hostSource,
      `import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { startDesktopBackend } from ${JSON.stringify(resolve(import.meta.dir, "../src/runtime.ts"))};

const source = await import(pathToFileURL(${JSON.stringify(join(relocated, "app.js"))}).href);
assert.equal(source.default.server, undefined);
const backend = await startDesktopBackend(
  () => Promise.resolve(source),
  ${JSON.stringify(join(fixture.path, "desktop-data"))},
  "build"
);
try {
  const paths = ["/request-shortcut", "/wrapper-shortcut", "/constant", "/api/host", "/", "/public/portable.txt"];
  for (const path of paths) {
    assert.equal((await fetch(backend.origin + path)).status, 403, path);
  }
  assert.deepEqual(source.default.getObserved(), []);
  const bootstrap = await fetch(backend.url, { redirect: "manual" });
  assert.equal(bootstrap.status, 303);
  const cookie = bootstrap.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const headers = { cookie };
  const request = await fetch(backend.origin + "/request-shortcut", { headers });
  assert.equal(request.status, 201);
  assert.equal(await request.text(), "request");
  const wrapper = await fetch(backend.origin + "/wrapper-shortcut", { headers });
  assert.equal(wrapper.status, 203);
  assert.equal(await wrapper.text(), "wrapper");
  assert.equal(await (await fetch(backend.origin + "/constant", { headers })).text(), "constant");
  assert.deepEqual(await (await fetch(backend.origin + "/api/host", { headers })).json(), { host: true });
  const page = await fetch(backend.origin + "/", { headers });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("Home page"));
  const asset = html.match(/src="([^"]+\\.js[^"]*)"/)?.[1];
  assert.ok(asset);
  const assetURL = new URL(asset, backend.origin);
  assert.equal((await fetch(assetURL)).status, 403);
  assert.equal((await fetch(assetURL, { headers })).status, 200);
  assert.equal(
    await (await fetch(backend.origin + "/public/portable.txt", { headers })).text(),
    "portable desktop asset"
  );
  assert.deepEqual(source.default.getLifecycle(), { setup: 1, cleanup: 0, shutdown: 0 });
} finally {
  await backend.stop();
}
assert.deepEqual(source.default.getLifecycle(), { setup: 1, cleanup: 1, shutdown: 1 });
await assert.rejects(fetch(backend.origin));
await assert.rejects(fetch(backend.url));
console.log("Relocated desktop app guard, SSR, assets and lifecycle passed");
process.exit(0);
`
    );
    const host = await Bun.build({
      entrypoints: [hostSource],
      metafile: true,
      outdir: join(fixture.path, "sdk-host"),
      target: "bun",
    });
    expect(host.success, host.logs.map(String).join("\n")).toBe(true);
    expect(host.metafile).toBeDefined();
    expect(JSON.stringify(host.metafile)).not.toContain("elysia/dist");
    const entry = host.outputs.find((output) => output.kind === "entry-point");
    if (!entry) {
      throw new Error("Missing bundled desktop host.");
    }
    const child = Bun.spawn([process.execPath, entry.path], {
      cwd: fixture.path,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 15_000,
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr + stdout).toBe(0);
    expect(stdout).toContain("Relocated desktop app guard, SSR, assets and lifecycle passed");
  } finally {
    fixture.cleanup();
  }
}, 60_000);
