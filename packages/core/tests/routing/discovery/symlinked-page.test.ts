import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionPages } from "../../support/production-app.ts";

// Inside the package so the fixture resolves `@teyik0/furin` and React.
const TMP_ROOT = join(import.meta.dir, "../../../.tmp-tests");
let pagesDir: string;
let originalDevMode: boolean;

beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
  mkdirSync(TMP_ROOT, { recursive: true });
  pagesDir = mkdtempSync(join(TMP_ROOT, "symlinked-page-"));
  writeFileSync(
    join(pagesDir, "root.tsx"),
    `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en"><head><HeadContent /></head><body>{children}<Scripts /></body></html>
  ));`
  );
  mkdirSync(join(pagesDir, "_shared"));
  writeFileSync(
    join(pagesDir, "_shared", "about.tsx"),
    `import { defineRoute } from "@teyik0/furin";
import { route as rootRoute } from "../root.tsx";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .page(() => <p>shared about page</p>);`
  );
  symlinkSync(join(pagesDir, "_shared", "about.tsx"), join(pagesDir, "about.tsx"));
});

afterAll(() => {
  __resetCompileContext();
  __setDevMode(originalDevMode);
  rmSync(pagesDir, { force: true, recursive: true });
});

test("a symlinked page file is served at its route", async () => {
  const { app } = await mountProductionPages(pagesDir, "");

  const response = await app.handle(new Request("http://localhost/about"));

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("shared about page");
});
