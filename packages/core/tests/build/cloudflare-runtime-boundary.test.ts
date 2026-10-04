import { expect, test } from "bun:test";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("Worker APIs default to private caching while preserving explicit public policies", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    writeAppFile(app.path, "src/server.ts", `import { furin } from "@teyik0/furin";
import Elysia from "elysia";
export default new Elysia()
  .get("/private/plain", ({ request }) => new Response(request.headers.get("cookie")))
  .get("/private/json", ({ request }) => ({ user: request.headers.get("cookie") }))
  .get("/private/mixed-html", ({ request }) => new Response(request.headers.get("cookie"), {
    headers: { "content-type": "Text/HTML; Charset=UTF-8", "cache-control": "public, max-age=60" },
  }))
  .get("/private/upper-html", ({ request }) => new Response(request.headers.get("cookie"), {
    headers: { "content-type": "TEXT/HTML", "cache-control": "public, max-age=60" },
  }))
  .get("/redirect", () => Response.redirect("https://example.com/", 302))
  .get("/public/data", () => new Response("public", { headers: { "cache-control": "public, max-age=60" } }))
  .get("/public/non-html", () => new Response("not HTML", {
    headers: { "content-type": "text/htmlish", "cache-control": "public, max-age=60" },
  }))
  .get("/upgrade", () => {
    const pair = new WebSocketPair();
    pair[1].accept();
    return new Response(null, { status: 101, webSocket: pair[0] });
  })
  .use(await furin({ pagesDir: "./src/pages" }));
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(app.path, ".furin/build/cloudflare/worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    const origin = await runtime.ready;
    for (const path of ["/private/plain", "/private/json", "/private/mixed-html", "/private/upper-html"]) {
      for (const user of ["alice", "bob"]) {
        const response = await fetch(new URL(path, origin), {
          headers: { cookie: `session=${user}` },
          signal: AbortSignal.timeout(5000),
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).toContain(user);
        expect(body).not.toContain(user === "alice" ? "bob" : "alice");
      }
    }
    const redirect = await fetch(new URL("/redirect", origin), {
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("cache-control")).toBe("private, no-store");
    const publicData = await fetch(new URL("/public/data", origin), {
      signal: AbortSignal.timeout(5000),
    });
    expect(publicData.status).toBe(200);
    expect(publicData.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await publicData.text()).toBe("public");
    const nonHtml = await fetch(new URL("/public/non-html", origin), {
      signal: AbortSignal.timeout(5000),
    });
    expect(nonHtml.status).toBe(200);
    expect(nonHtml.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await nonHtml.text()).toBe("not HTML");
    const upgrade = await runtime.dispatchFetch("http://localhost/upgrade", {
      headers: { upgrade: "websocket" },
    });
    expect(upgrade.status).toBe(101);
    expect(upgrade.webSocket).not.toBeNull();
    upgrade.webSocket?.accept();
    upgrade.webSocket?.close();
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);

test("Workers retain user dependency renderer resolution while using Furin's edge renderer", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    writeAppFile(app.path, "node_modules/custom-renderer/package.json", JSON.stringify({
      name: "custom-renderer",
      type: "module",
      exports: "./index.js",
    }));
    writeAppFile(app.path, "node_modules/custom-renderer/index.js", `export { rendererName } from "react-dom/server";`);
    writeAppFile(app.path, "node_modules/custom-renderer/node_modules/react-dom/package.json", JSON.stringify({
      name: "react-dom",
      type: "module",
      exports: { "./server": "./server.js" },
    }));
    writeAppFile(app.path, "node_modules/custom-renderer/node_modules/react-dom/server.js", `export const rendererName = "user-renderer";`);
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import { rendererName } from "custom-renderer";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ renderer: rendererName }))
  .page(({ renderer }) => <main>{renderer}</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(app.path, ".furin/build/cloudflare/worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    const origin = await runtime.ready;
    const response = await fetch(new URL("/dashboard", origin), {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("user-renderer");
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);

test("Workers SSR pages inherit private layout request loaders", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    writeAppFile(app.path, "src/pages/private/_route.tsx", `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .requestLoader(({ request }) => ({ user: request.headers.get("cookie") }))
  .layout(({ children }) => <section>{children}</section>);
`);
    writeAppFile(app.path, "src/pages/private/index.tsx", `import { defineRoute } from "@teyik0/furin";
import { use } from "react";
import { route as layoutRoute } from "./_route";
export const route = defineRoute()
  .config({ layout: layoutRoute, mode: "ssr" })
  .page(({ user }) => <main>{use(user)}</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(app.path, ".furin/build/cloudflare/worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    const origin = await runtime.ready;
    for (const path of ["/private", "/_furin/data?path=%2Fprivate"]) {
      const response = await fetch(new URL(path, origin), {
        headers: { cookie: "session=alice" },
        signal: AbortSignal.timeout(5000),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toContain("session=alice");
    }
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);
