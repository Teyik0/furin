import { afterEach, expect, test } from "bun:test";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures.ts";
import { runProcess } from "../../support/process.ts";

const TESTS_DIR_SUFFIX_RE = /[\\/]tests(?:[\\/].*)?$/;
// Fixtures are owned by the parent so they are removed even if the child dies.
const fixtures: TmpApp[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

test("furin() catch-all 404 scenarios", async () => {
  fixtures.push(...Array.from({ length: 5 }, () => createTmpApp("cli-app")));
  const proc = await runProcess(
    [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia, NotFound } from "elysia";
import { furin } from "furin";
import { __resetCompileContext } from "./src/server/internal.ts";
import { setProductionTemplatePath } from "./src/server/render/template.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { writeAppFile } from "./tests/support/app-fixtures.ts";

const fixturePaths = JSON.parse(process.env.FURIN_TEST_FIXTURE_PATHS);
// The parent test owns and removes these fixtures.
function takeFixture() {
  return { cleanup: () => undefined, path: fixturePaths.shift() };
}

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
  let app = takeFixture();
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
  app = takeFixture();
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
  app = takeFixture();
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
    .onError(NotFound, ({ path }) => {
      if (path.startsWith("/api/")) {
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
  app = takeFixture();
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
  app = takeFixture();
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
    {
      cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
      env: { FURIN_TEST_FIXTURE_PATHS: JSON.stringify(fixtures.map((f) => f.path)) },
      timeoutMs: 25_000,
    }
  );

  if (proc.exitCode !== 0) {
    throw new Error(
      [`furin not-found subprocess exited with ${proc.exitCode}`, proc.stdout, proc.stderr].join(
        "\n"
      )
    );
  }

  expect(proc.exitCode).toBe(0);
}, 30_000);
