import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Elysia } from "elysia";
import type { CompileContext } from "../../../src/server/internal";
import { resetEvlogMock } from "../../setup/evlog-mock";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures";

const { furin } = await import("../../../src/furin");
const { __clearInstanceRegistry } = await import("../../../src/server/instance");
const { __resetCompileContext, __setCompileContext } = await import("../../../src/server/internal");
const { __resetTemplateState } = await import("../../../src/server/render/template");
const { __setDevMode } = await import("../../../src/server/runtime-env");

let tmpApp: TmpApp | undefined;

async function createProductionContext(appPath: string, prefix: string): Promise<void> {
  const rootPath = join(appPath, "src/pages/root.tsx");
  const indexPath = join(appPath, "src/pages/index.tsx");
  const [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);
  const clientDir = join(appPath, "client");
  mkdirSync(clientDir);
  writeFileSync(join(clientDir, "index.html"), "<html><body><!--app-html--></body></html>");
  const context: CompileContext = {
    embedded: { clientDir },
    modules: { [rootPath]: rootMod, [indexPath]: indexMod },
    nativeRoutes: new Elysia().use(
      rootMod.route.elysia.use(new Elysia().use(indexMod.route.elysia))
    ),
    prefix,
    rootConventions: {},
    rootPath,
    routeMetadata: { [indexPath]: { segmentBoundaries: [] } },
    routes: [{ mode: "ssg", path: indexPath, pattern: "/" }],
  };
  __setCompileContext(context);
}

afterEach(() => {
  resetEvlogMock();
  __setDevMode(true);
  __resetTemplateState();
  __resetCompileContext();
  __clearInstanceRegistry();
  tmpApp?.cleanup();
  tmpApp = undefined;
});

// Regression guard for https://github.com/elysiajs/elysia/issues/1969: in
// Elysia 1.4 an onError handler returning `status()` mutates the shared
// NotFoundError singleton, so every 404 after the first becomes a 500.
// Elysia 2 betas build a fresh NotFound per request and Furin's handlers
// return a Response, so both requests must stay 404.
for (const prefix of ["", "/admin"]) {
  test.serial(
    `production mount "${prefix || "/"}" keeps returning 404 for unknown URLs`,
    async () => {
      tmpApp = createTmpApp("cli-app");
      __setDevMode(false);
      await createProductionContext(tmpApp.path, prefix);
      const pagesDir = join(tmpApp.path, "src/pages");
      const app = new Elysia().use(await furin(prefix ? { pagesDir, prefix } : { pagesDir }));

      const first = await app.handle(new Request(`http://localhost${prefix}/missing-one`));
      const second = await app.handle(new Request(`http://localhost${prefix}/missing-two`));

      expect(first.status).toBe(404);
      expect(second.status).toBe(404);
    }
  );
}

for (const mode of ["development", "production"] as const) {
  for (const prefix of ["", "/admin"]) {
    test.serial(
      `${mode} mount "${prefix || "/"}" answers unknown documents and navigation data with 404`,
      async () => {
        tmpApp = createTmpApp("cli-app");
        __setDevMode(mode === "development");
        if (mode === "production") {
          await createProductionContext(tmpApp.path, prefix);
        }
        const pagesDir = join(tmpApp.path, "src/pages");
        const app = new Elysia().use(await furin(prefix ? { pagesDir, prefix } : { pagesDir }));

        const document = await app.handle(new Request(`http://localhost${prefix}/missing`));
        const data = await app.handle(new Request(`http://localhost${prefix}/missing?_furin=data`));

        expect(document.status).toBe(404);
        expect(document.headers.get("content-type")).toContain("text/html");
        // The router loads the URL as a document, so data gets no 404 render.
        expect(data.status).toBe(404);
        expect(data.headers.get("cache-control")).toBe("private, no-store");
        expect(await data.text()).toBe("");
      }
    );
  }
}
