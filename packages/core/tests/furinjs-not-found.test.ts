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

  test("does NOT hijack 404s when furin is mounted alongside API routes", async () => {
    // Design decision: furin's catch-all uses local scope only, so it never
    // interferes with sibling APIs. A parent Elysia that mounts furin AND
    // defines its own routes handles its own 404s (JSON, auth redirects, …).
    // The user wiring up HTML 404s at the parent level is responsible for
    // calling `renderRootNotFound` themselves in their own `.onError`.
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
    // Crucially: it does NOT contain the user-defined not-found.tsx content.
    // The parent's default Elysia 404 (or the user's own onError) is in charge.
    const apiBody = await apiResponse.text();
    expect(apiBody).not.toContain("Nothing at this URL");
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
    expect(body).toContain("404 — Not Found");
  });
});
