import { expect, test } from "bun:test";

const TESTS_DIR_SUFFIX_RE = /\/tests(?:\/.*)?$/;

test("request scope isolation when furin is mounted as a plugin", () => {
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
import { createTmpApp, writeAppFile } from "./tests/support/app-fixtures.ts";

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
  let app = createTmpApp("cli-app");
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
  app = createTmpApp("cli-app");
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
});
