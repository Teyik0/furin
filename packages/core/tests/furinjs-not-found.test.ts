/**
 * Integration test: the furin() plugin serves the root not-found.tsx with a
 * 404 status when a request URL does not match any registered route.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "../src/furin.ts";
import { __resetCompileContext } from "../src/internal.ts";
import { setProductionTemplatePath } from "../src/render/template.ts";
import { __setDevMode } from "../src/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./helpers/tmp-app.ts";

const tmpApps: Array<{ cleanup: () => void }> = [];
const originalCwd = process.cwd();

const FURIN_DATA_RE = /<script id="__FURIN_DATA__"[^>]*>([\s\S]*?)<\/script>/;

afterEach(() => {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  process.chdir(originalCwd);
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

describe.serial("furin() — catch-all 404", () => {
  test("renders the root not-found.tsx with 404 status for an unknown URL", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    writeAppFile(
      app.path,
      "src/pages/not-found.tsx",
      'export default function RootNotFound() { return <div data-testid="root-not-found">Nothing at this URL</div>; }\n'
    );

    const instance = await furin({ pagesDir: join(app.path, "src/pages") });
    const response = await instance.handle(new Request("http://furin/does-not-exist"));

    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("Nothing at this URL");
  });

  test("renders the user's not-found.tsx for parent-level 404s when mounted as a sub-plugin", async () => {
    // Design decision (rev 2): furin owns the 404 page by default — same as
    // Next.js / Tanstack Start. Without this, a typical setup
    // (`new Elysia().get("/api/...").use(await furin(...))`) leaks Elysia's
    // raw `NOT_FOUND` plain-text response when the URL doesn't match any
    // route. Users who want a JSON 404 for `/api/*` register their own
    // `.onError` BEFORE `.use(furin(...))` — see the next test.
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    writeAppFile(
      app.path,
      "src/pages/not-found.tsx",
      "export default function RootNotFound() { return <div>Nothing at this URL</div>; }\n"
    );

    const plugin = await furin({ pagesDir: join(app.path, "src/pages") });
    const parent = new Elysia().use(plugin).get("/api/ping", () => ({ ok: true }));

    const apiResponse = await parent.handle(new Request("http://furin/api/does-not-exist"));
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("Content-Type")).toContain("text/html");
    const apiBody = await apiResponse.text();
    expect(apiBody).toContain("Nothing at this URL");
  });

  test("a parent .onError registered BEFORE .use(furin) wins (escape hatch for JSON API 404s)", async () => {
    // Documents the override pattern: register a NOT_FOUND handler on the
    // parent before mounting furin, and Elysia's first-match-wins resolution
    // lets it short-circuit furin's global handler for the matching paths.
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    writeAppFile(
      app.path,
      "src/pages/not-found.tsx",
      "export default function RootNotFound() { return <div>HTML 404</div>; }\n"
    );

    const plugin = await furin({ pagesDir: join(app.path, "src/pages") });
    const parent = new Elysia()
      .onError(({ code, path }) => {
        if (code === "NOT_FOUND" && path.startsWith("/api/")) {
          return new Response(JSON.stringify({ error: "not_found" }), {
            headers: { "Content-Type": "application/json" },
            status: 404,
          });
        }
      })
      .use(plugin);

    const apiResponse = await parent.handle(new Request("http://furin/api/missing"));
    expect(apiResponse.status).toBe(404);
    expect(apiResponse.headers.get("Content-Type")).toContain("application/json");
    const apiBody = await apiResponse.json();
    expect(apiBody).toEqual({ error: "not_found" });
  });

  test("falls back to the built-in 404 component when no not-found.tsx exists", async () => {
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    const instance = await furin({ pagesDir: join(app.path, "src/pages") });
    const response = await instance.handle(new Request("http://furin/does-not-exist"));

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).toContain("404 — NOT FOUND");
  });

  test("embeds __furinStatus: 404 in __FURIN_DATA__ for SPA client detection", async () => {
    // renderRootNotFound must inject the SPA signal so that client-side
    // fetchPageState can detect the catch-all 404 via classifySpaResponse
    // and render the not-found UI inline instead of doing a full-page reload
    // when navigating to an unmatched URL.
    const app = createTmpApp("cli-app");
    tmpApps.push(app);
    __setDevMode(true);
    process.chdir(app.path);

    const instance = await furin({ pagesDir: join(app.path, "src/pages") });
    const response = await instance.handle(new Request("http://furin/no-route-here"));

    expect(response.status).toBe(404);
    const body = await response.text();
    const match = body.match(FURIN_DATA_RE);
    expect(match).not.toBeNull();
    const data = JSON.parse(match?.[1] ?? "{}");
    expect(data.__furinStatus).toBe(404);
  });
});
