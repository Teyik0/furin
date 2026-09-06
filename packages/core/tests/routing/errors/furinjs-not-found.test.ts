import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

test("furin() catch-all 404 scenarios", () => {
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin } from "furin";
import { __resetCompileContext } from "./src/server/internal.ts";
import { setProductionTemplatePath } from "./src/server/render/template.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";

const tmpApps = [];
const originalCwd = process.cwd();
const furinDataRe = /<script id="__FURIN_DATA__"[^>]*>([\\s\\S]*?)<\\/script>/;

function resetNotFoundTestState() {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  process.chdir(originalCwd);
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

try {
  resetNotFoundTestState();
  let app = createTmpApp("cli-app");
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  writeAppFile(
    app.path,
    "src/pages/not-found.tsx",
    'export default function RootNotFound() { return <div data-testid="root-not-found">Nothing at this URL</div>; }\\n'
  );

  let plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  let parent = new Elysia().use(plugin);
  let response = await parent.handle(new Request("http://furin/does-not-exist"));

  expect(response.status).toBe(404);
  expect(response.headers.get("Content-Type")).toContain("text/html");
  let body = await response.text();
  expect(body).toContain("Nothing at this URL");

  resetNotFoundTestState();
  app = createTmpApp("cli-app");
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  writeAppFile(
    app.path,
    "src/pages/not-found.tsx",
    "export default function RootNotFound() { return <div>Nothing at this URL</div>; }\\n"
  );

  plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  parent = new Elysia().use(plugin).get("/api/ping", () => ({ ok: true }));

  let apiResponse = await parent.handle(new Request("http://furin/api/does-not-exist"));
  expect(apiResponse.status).toBe(404);
  expect(apiResponse.headers.get("Content-Type")).toContain("text/html");
  let apiBody = await apiResponse.text();
  expect(apiBody).toContain("Nothing at this URL");

  resetNotFoundTestState();
  app = createTmpApp("cli-app");
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  writeAppFile(
    app.path,
    "src/pages/not-found.tsx",
    "export default function RootNotFound() { return <div>HTML 404</div>; }\\n"
  );

  plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  parent = new Elysia()
    .onError(({ code, path }) => {
      if (code === "NOT_FOUND" && path.startsWith("/api/")) {
        return new Response(JSON.stringify({ error: "not_found" }), {
          headers: { "Content-Type": "application/json" },
          status: 404,
        });
      }
    })
    .use(plugin);

  apiResponse = await parent.handle(new Request("http://furin/api/missing"));
  expect(apiResponse.status).toBe(404);
  expect(apiResponse.headers.get("Content-Type")).toContain("application/json");
  apiBody = await apiResponse.json();
  expect(apiBody).toEqual({ error: "not_found" });

  resetNotFoundTestState();
  app = createTmpApp("cli-app");
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  parent = new Elysia().use(plugin);
  response = await parent.handle(new Request("http://furin/does-not-exist"));

  expect(response.status).toBe(404);
  body = await response.text();
  expect(body).toContain("404 — NOT FOUND");

  resetNotFoundTestState();
  app = createTmpApp("cli-app");
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  parent = new Elysia().use(plugin);
  response = await parent.handle(new Request("http://furin/no-route-here"));

  expect(response.status).toBe(404);
  body = await response.text();
  const match = body.match(furinDataRe);
  expect(match).not.toBeNull();
  const data = JSON.parse(match?.[1] ?? "{}");
  expect(data.__furinStatus).toBe(404);
} finally {
  resetNotFoundTestState();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `furin not-found subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
});
