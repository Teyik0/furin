import { afterEach, expect, test } from "bun:test";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures.ts";

const TESTS_DIR_SUFFIX_RE = /[\\/]tests(?:[\\/].*)?$/;
// Fixtures are owned by the parent so they are removed even if the child dies.
const fixtures: TmpApp[] = [];

afterEach(() => {
  while (fixtures.length > 0) {
    fixtures.pop()?.cleanup();
  }
});

test("request scope isolation when furin is mounted as a plugin", () => {
  fixtures.push(...Array.from({ length: 2 }, () => createTmpApp("cli-app")));
  const proc = Bun.spawnSync({
    cmd: [
      "bun",
      "-e",
      `
import { expect } from "bun:test";
import { join } from "node:path";
import { Elysia } from "elysia";
import { furin, revalidatePath } from "furin";
import { __resetCacheState } from "./src/server/cache/index.ts";
import { __resetCompileContext } from "./src/server/internal.ts";
import {
  setProductionTemplateContent,
  setProductionTemplatePath,
} from "./src/server/render/template.ts";
import { __setDevMode } from "./src/server/runtime-env.ts";
import { writeAppFile } from "./tests/support/app-fixtures.ts";

const fixturePaths = JSON.parse(process.env.FURIN_TEST_FIXTURE_PATHS);
// The parent test owns and removes these fixtures.
function takeFixture() {
  return { cleanup: () => undefined, path: fixturePaths.shift() };
}

const tmpApps = [];
const originalCwd = process.cwd();

function resetState() {
  __setDevMode(true);
  setProductionTemplatePath(null);
  __resetCompileContext();
  process.chdir(originalCwd);
  __resetCacheState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

function writeRevalidatePages(appPath, asyncLoader) {
  const loaderPrefix = asyncLoader ? "async " : "";
  writeAppFile(
    appPath,
    "src/pages/revalidate-a.tsx",
    [
      'import { defineRoute, revalidatePath } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .loader(" + loaderPrefix + "() => {",
      '    revalidatePath("/page-a", "page");',
      "    return {};",
      "  }).page(() => <div>Page A</div>);",
    ].join("\\n")
  );

  writeAppFile(
    appPath,
    "src/pages/revalidate-b.tsx",
    [
      'import { defineRoute, revalidatePath } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .loader(" + loaderPrefix + "() => {",
      '    revalidatePath("/page-b", "page");',
      "    return {};",
      "  }).page(() => <div>Page B</div>);",
    ].join("\\n")
  );
}

try {
  resetState();
  let app = takeFixture();
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  writeRevalidatePages(app.path, false);
  setProductionTemplateContent("<html><body><!--ssr-outlet--></body></html>");

  let plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  let parent = new Elysia().use(plugin);

  revalidatePath("/global-leak", "page");

  let response = await parent.handle(new Request("http://furin/revalidate-a"));
  expect(response.headers.get("x-furin-revalidate")).toBe("/page-a");

  resetState();
  app = takeFixture();
  tmpApps.push(app);
  __setDevMode(true);
  process.chdir(app.path);

  writeRevalidatePages(app.path, true);
  setProductionTemplateContent("<html><body><!--ssr-outlet--></body></html>");

  plugin = await furin({ pagesDir: join(app.path, "src/pages") });
  parent = new Elysia().use(plugin);

  const [resA, resB] = await Promise.all([
    parent.handle(new Request("http://furin/revalidate-a")),
    parent.handle(new Request("http://furin/revalidate-b")),
  ]);

  expect(resA.headers.get("x-furin-revalidate")).toBe("/page-a");
  expect(resB.headers.get("x-furin-revalidate")).toBe("/page-b");
} finally {
  resetState();
}
`,
    ],
    cwd: import.meta.dir.replace(TESTS_DIR_SUFFIX_RE, ""),
    env: { ...process.env, FURIN_TEST_FIXTURE_PATHS: JSON.stringify(fixtures.map((f) => f.path)) },
    stderr: "pipe",
    stdout: "pipe",
  });

  if (proc.exitCode !== 0) {
    throw new Error(
      [
        `request scope subprocess exited with ${proc.exitCode}`,
        new TextDecoder().decode(proc.stdout),
        new TextDecoder().decode(proc.stderr),
      ].join("\n")
    );
  }

  expect(proc.exitCode).toBe(0);
}, 30_000);
