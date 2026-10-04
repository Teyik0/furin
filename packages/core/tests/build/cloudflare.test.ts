import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("Cloudflare builds a native Worker and Wrangler static assets configuration", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const output = join(app.path, ".furin/build/cloudflare");
    const config = await Bun.file(join(output, "wrangler.jsonc")).json();
    expect(config.main).toBe("worker.js");
    expect(config.compatibility_flags).toContain("nodejs_compat");
    expect(config.assets.directory).toBe("./assets");
    expect(await Bun.file(join(output, "worker.js")).exists()).toBe(true);
  } finally {
    app.cleanup();
  }
}, 60_000);

test("private Worker documents and navigation cannot be cached or cross sessions", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(({ request }) => ({ user: request.headers.get("cookie") ?? "guest" }))
  .page(({ user }) => <main>Account {user}</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(app.path, ".furin/build/cloudflare/worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    for (const path of ["/dashboard", "/_furin/data?path=%2Fdashboard"]) {
      for (const user of ["alice", "bob"]) {
        const response = await runtime.dispatchFetch(`http://localhost${path}`, {
          headers: { cookie: `session=${user}` },
        });
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("private, no-store");
        const body = await response.text();
        expect(body).toContain(user);
        expect(body).not.toContain(user === "alice" ? "bob" : "alice");
      }
    }
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);

test("the emitted Worker renders SSR and SSG with hydration and navigation in workerd", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{
        type: "ESModule",
        path: join(app.path, ".furin/build/cloudflare/worker.js"),
      }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    const origin = await runtime.ready;
    const response = await fetch(new URL("/dashboard", origin), {
      signal: AbortSignal.timeout(5000),
    });
    const html = await response.text();
    expect(response.status, html).toBe(200);
    expect(html).toContain("Dashboard for");
    expect(html).toContain("Alice");
    expect(html).toContain("/_client/");
    const home = await fetch(new URL("/", origin), { signal: AbortSignal.timeout(5000) });
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("Home page");
    const data = await fetch(new URL("/_furin/data?path=%2Fdashboard", origin), {
      signal: AbortSignal.timeout(5000),
    });
    expect(data.status).toBe(200);
    expect(await data.text()).toContain("Alice");
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);

test("Cloudflare explicitly rejects ISR instead of silently using isolate-local caching", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr", revalidate: 60 })
  .page(() => <main>ISR</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("Cloudflare Workers does not support ISR");
    expect(build.stderr).toContain("global invalidation");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Cloudflare rejects ISR layouts even when the document is SSR", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "src/pages/private/_route.tsx", `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "isr", revalidate: 60 })
  .loader(() => ({ title: "ISR layout" }))
  .layout(({ children }) => <section>{children}</section>);
`);
    writeAppFile(app.path, "src/pages/private/index.tsx", `import { defineRoute } from "@teyik0/furin";
import { route as layoutRoute } from "./_route";
export const route = defineRoute()
  .config({ layout: layoutRoute, mode: "ssr" })
  .page(() => <main>Private dashboard</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("Cloudflare Workers does not support ISR");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Cloudflare cannot mount apps inside its immutable asset namespace", async () => {
  for (const prefix of ["/_client", "/_client/nested"]) {
    const app = createTmpApp("cli-app-ssr");
    try {
      writeAppFile(app.path, "src/server.ts", `import { furin } from "@teyik0/furin";
import Elysia from "elysia";
export default new Elysia().use(await furin({ pagesDir: "./src/pages", prefix: ${JSON.stringify(prefix)} }));
`);
      const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
      expect(build.exitCode).toBe(1);
      expect(build.stderr).toContain("reserved /_client namespace");
    } finally {
      app.cleanup();
    }
  }
}, 60_000);

test("Workers assets serve only browser bundles and public files with immutable hashed caching", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    writeAppFile(app.path, "public/unhashed.js", "console.log('public');");
    writeAppFile(app.path, "public/favicon.ico", "favicon");
    writeAppFile(app.path, "public/_headers", "/*\n  X-Content-Type-Options: nosniff\n  Cache-Control: public, max-age=60\n");
    writeAppFile(app.path, "src/pages/photo.css", "main { background-image: url('./photo.svg'); }");
    writeAppFile(app.path, "src/pages/photo.svg", `<svg xmlns="http://www.w3.org/2000/svg"><!--${"x".repeat(8000)}--><circle r="10"/></svg>`);
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import "./photo.css";
import photo from "./photo.svg" with { type: "file" };
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => <main><img src={photo} alt="Photo" /></main>);
`);
    writeAppFile(app.path, "src/server.ts", `import { furin } from "@teyik0/furin";
import Elysia from "elysia";
export default new Elysia()
  .use(await furin({ pagesDir: "./src/pages" }))
  .use(await furin({ pagesDir: "./src/pages", prefix: "/admin" }));
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const output = join(app.path, ".furin/build/cloudflare");
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(output, "worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      assets: {
        directory: join(output, "assets"),
        routerConfig: { has_user_worker: true },
        assetConfig: { html_handling: "none", not_found_handling: "none" },
      },
    });
    const filename = readdirSync(join(output, "assets/_client")).find((file) => file.startsWith("_hydrate") && file.endsWith(".js"));
    expect(filename).toBeDefined();
    const client = await runtime.dispatchFetch(`http://localhost/_client/${filename}`);
    expect(client.status).toBe(200);
    expect(client.headers.get("x-content-type-options")).toBe("nosniff");
    expect(client.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await client.text()).toContain("hydrate");
    const publicFile = await runtime.dispatchFetch("http://localhost/unhashed.js");
    expect(publicFile.status).toBe(200);
    expect(publicFile.headers.get("cache-control")).toBe("public, max-age=60");
    const headerRules = await Bun.file(join(output, "assets/_headers")).text();
    expect(headerRules.match(/^\/_client\//gm)).toHaveLength(1);
    const image = readdirSync(join(output, "assets/_client")).find((file) => file.endsWith(".svg"));
    expect(image).toBeDefined();
    const imageResponse = await runtime.dispatchFetch(`http://localhost/_client/${image}`);
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const photoPage = await runtime.dispatchFetch("http://localhost/dashboard");
    expect(await photoPage.text()).toContain(`src="/_client/${image}"`);
    const adminPage = await runtime.dispatchFetch("http://localhost/admin/dashboard");
    expect(adminPage.status).toBe(200);
    expect(await adminPage.text()).toContain(`src="/_client/${image}"`);
    const adminData = await runtime.dispatchFetch("http://localhost/admin/_furin/data?path=%2Fdashboard");
    expect(adminData.status).toBe(200);
    expect(adminData.headers.get("cache-control")).toBe("private, no-store");
    await adminData.text();
    const adminIcon = await runtime.dispatchFetch("http://localhost/admin/favicon.ico");
    expect(adminIcon.status).toBe(200);
    expect(await adminIcon.text()).toBe("favicon");
    for (const path of ["/_client/index.html", "/worker.js", "/wrangler.jsonc"]) {
      const response = await runtime.dispatchFetch(`http://localhost${path}`);
      expect(response.status).toBe(404);
    }
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);

test("Cloudflare protects its immutable asset namespace and the platform header-rule budget", async () => {
  const cases = [
    { file: "public/_client/unhashed.js", contents: "export const secret = true;", message: "reserves public/_client" },
    { file: "public/_headers", contents: "/_client/* \n  Cache-Control: no-store\n", message: "reserves the /_client/* rule" },
    { file: "public/_headers", contents: Array.from({ length: 100 }, (_, index) => `/custom-${index}\n  X-Test: yes\n`).join("\n"), message: "at most 99 custom rules" },
  ];
  for (const sample of cases) {
    const app = createTmpApp("cli-app-ssr");
    try {
      writeAppFile(app.path, sample.file, sample.contents);
      const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
      expect(build.exitCode, sample.file).toBe(1);
      expect(build.stderr).toContain(sample.message);
    } finally {
      app.cleanup();
    }
  }
}, 60_000);

test("Cloudflare rejects server-only file assets instead of emitting broken CDN URLs", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "src/pages/server-photo.svg", `<svg xmlns="http://www.w3.org/2000/svg">${"x".repeat(8000)}</svg>`);
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import photo from "./server-photo.svg" with { type: "file" };
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ photo }))
  .page(({ photo }) => <main><img src={photo} alt="Photo" /></main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("server-only file asset");
    expect(build.stderr).toContain("public/");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Cloudflare rejects PPR rather than caching private request-loader output", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssg" })
  .requestLoader(() => ({ user: "private" }))
  .page(({ user }) => <main>{user}</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("Cloudflare Workers does not support PPR");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Cloudflare rejects enabled Sync explicitly", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "src/server.ts", `import { furin } from "@teyik0/furin";
import Elysia from "elysia";
export default new Elysia().use(await furin({
  pagesDir: import.meta.dir + "/pages",
  sync: { adapter: {}, principal: () => "user" },
}));
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("Cloudflare Workers does not support Furin Sync");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Cloudflare rejects RSC imports explicitly", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import { renderServerComponent } from "@teyik0/furin/rsc";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(async () => ({ content: await renderServerComponent(<div>RSC</div>) }))
  .page(({ content }) => <main>{content}</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode).toBe(1);
    expect(build.stderr).toContain("Cloudflare Workers does not support RSC");
  } finally {
    app.cleanup();
  }
}, 60_000);

test("Workers preserves deferred HTML and navigation streams without buffering", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { Await, defer, defineRoute } from "@teyik0/furin";
import { Suspense } from "react";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => defer({
    title: "initial-shell",
    slow: new Promise<string>((resolve) => setTimeout(() => resolve("late-value"), 1000)),
  }))
  .page(({ title, slow }) => <main>{title}<Suspense fallback={<p>loading</p>}><Await resolve={slow}>{(value) => <p>{value}</p>}</Await></Suspense></main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(app.path, ".furin/build/cloudflare/worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    for (const path of ["/dashboard", "/_furin/data?path=%2Fdashboard"]) {
      const response = await runtime.dispatchFetch(`http://localhost${path}`, {
        headers: { "accept-encoding": "identity" },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error("Worker response has no stream.");
      }
      const first = await reader.read();
      const initial = new TextDecoder().decode(first.value);
      expect(initial).toContain("initial-shell");
      expect(initial).not.toContain("late-value");
      let remaining = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) {
          break;
        }
        remaining += new TextDecoder().decode(chunk.value);
      }
      expect(remaining).toContain("late-value");
    }
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);

test("--target all preserves the existing targets and keeps Cloudflare opt-in", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(app.path, "furin.config.ts", `export default { static: { onSSR: "skip" } };`);
    const build = await runCli(["build", "--target", "all"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    const manifest = await Bun.file(join(app.path, ".furin/build/manifest.json")).json();
    expect(Object.keys(manifest.targets).sort()).toEqual(["bun", "static", "vercel"]);
    expect(await Bun.file(join(app.path, ".furin/build/cloudflare/worker.js")).exists()).toBe(false);
  } finally {
    app.cleanup();
  }
}, 60_000);
