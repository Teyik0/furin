import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AnyElysia } from "elysia";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionPages } from "../../support/production-app.ts";

// Inside the package so the fixture resolves `@teyik0/furin` and React.
const TMP_ROOT = join(import.meta.dir, "../../../.tmp-tests");

const FILES: { [path: string]: string } = {
  "__root.tsx": `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .notFound(() => <p data-fallback="root-not-found">root not found</p>)
  .layout(({ children }) => (
    <html lang="en"><head><HeadContent /></head><body data-layout="root">{children}<Scripts /></body></html>
  ));`,
  "shop/route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/shop")
  .config({ mode: "ssr" })
  .error(({ error }) => <p data-fallback="shop-error">{error.message}</p>)
  .layout(({ children }) => <section data-layout="shop">{children}</section>);`,
  "shop/broken.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/shop/broken")
  .config({ mode: "ssr" })
  .loader(() => { throw new Error("broken page"); })
  .error(({ error }) => <p data-fallback="page-error">{error.message}</p>)
  .page(() => <p>unreachable</p>);`,
  "shop/plain.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/shop/plain")
  .config({ mode: "ssr" })
  .loader(() => { throw new Error("plain page"); })
  .page(() => <p>unreachable</p>);`,
  "shop/missing.tsx": `import { defineRoute, notFound } from "@teyik0/furin";
export const route = defineRoute("/shop/missing")
  .config({ mode: "ssr" })
  .loader(() => notFound())
  .page(() => <p>unreachable</p>);`,
  "vault/route.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/vault")
  .config({ mode: "ssr" })
  .loader(() => { throw new Error("vault layout"); })
  .error(({ error }) => <p data-fallback="vault-error">{error.message}</p>)
  .layout(({ children }) => <section data-layout="vault">{children}</section>);`,
  "vault/index.tsx": `import { defineRoute } from "@teyik0/furin";
export const route = defineRoute("/vault/")
  .config({ mode: "ssr" })
  .page(() => <p>vault</p>);`,
};

let pagesDir: string;
let app: AnyElysia;
let originalDevMode: boolean;

beforeAll(async () => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
  mkdirSync(TMP_ROOT, { recursive: true });
  pagesDir = mkdtempSync(join(TMP_ROOT, "tanstack-boundaries-"));
  for (const [path, source] of Object.entries(FILES)) {
    mkdirSync(dirname(join(pagesDir, path)), { recursive: true });
    writeFileSync(join(pagesDir, path), source);
  }
  ({ app } = await mountProductionPages({ pagesDir, prefix: "", style: "tanstack" }, ""));
});

afterAll(() => {
  __resetCompileContext();
  __setDevMode(originalDevMode);
  // beforeAll may have failed before assigning it.
  if (typeof pagesDir === "string") {
    rmSync(pagesDir, { force: true, recursive: true });
  }
});

async function render(path: string): Promise<{ html: string; status: number }> {
  const response = await app.handle(new Request(`http://localhost${path}`));
  return { html: await response.text(), status: response.status };
}

test("a page's .error() renders inside its parent layout", async () => {
  const { html, status } = await render("/shop/broken");
  expect(status).toBe(500);
  expect(html).toContain('data-fallback="page-error"');
  expect(html).toContain('data-layout="shop"');
});

test("a layout's .error() catches a child failure in place of the layout", async () => {
  const { html, status } = await render("/shop/plain");
  expect(status).toBe(500);
  expect(html).toContain('data-fallback="shop-error"');
  expect(html).not.toContain('data-layout="shop"');
  expect(html).toContain('data-layout="root"');
});

test("a layout's .error() catches the layout's own failure", async () => {
  const { html, status } = await render("/vault");
  expect(status).toBe(500);
  expect(html).toContain('data-fallback="vault-error"');
  expect(html).not.toContain('data-layout="vault"');
  expect(html).toContain('data-layout="root"');
});

test("notFound() bubbles to the root's .notFound()", async () => {
  const { html, status } = await render("/shop/missing");
  expect(status).toBe(404);
  expect(html).toContain('data-fallback="root-not-found"');
});

test("an unmatched URL renders the root's .notFound()", async () => {
  const { html, status } = await render("/nowhere");
  expect(status).toBe(404);
  expect(html).toContain('data-fallback="root-not-found"');
});

test.each([false, true])(
  "discovery places route boundaries by chain depth (dev=%p)",
  async (dev) => {
    __setDevMode(dev);
    try {
      const { root, routes } = await scanPages({ pagesDir, prefix: "", style: "tanstack" });
      const boundaries = (pattern: string) =>
        routes
          .find((route) => route.pattern === pattern)
          ?.segmentBoundaries.map(({ depth, error, fromRoute, notFound }) => ({
            depth,
            error: error !== undefined,
            fromRoute,
            notFound: notFound !== undefined,
          }));
      expect(root.notFound).toBeDefined();
      // Root boundary at 0, shop layout (chain index 1) at 0, the page inside shop at 1.
      expect(boundaries("/shop/broken")).toEqual([
        { depth: 0, error: false, fromRoute: true, notFound: true },
        { depth: 0, error: true, fromRoute: true, notFound: false },
        { depth: 1, error: true, fromRoute: true, notFound: false },
      ]);
    } finally {
      __setDevMode(false);
    }
  }
);
