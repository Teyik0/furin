/**
 * Integration test: pages loaded via furin-dev-page namespace must share the
 * same React instance as react-dom/server.
 *
 * Regression test for: "dispatcher is null" hook crash on HMR.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, createContext as mainCreateContext, useState as mainUseState } from "react";
import { renderToString } from "react-dom/server";
import { registerDevPagePlugin } from "../src/dev-page-plugin.ts";
import { buildElement } from "../src/render/element.tsx";

registerDevPagePlugin();

const TMP_DIR = join(import.meta.dir, ".tmp-singleton-test");

function requirePath(paths: Record<string, string>, name: string): string {
  const path = paths[name];
  if (!path) {
    throw new Error(`Missing temp path for ${name}`);
  }
  return path;
}

function withTmpFiles(
  files: Record<string, string | ((paths: Record<string, string>) => string)>,
  fn: (paths: Record<string, string>) => Promise<void>
): Promise<void> {
  mkdirSync(TMP_DIR, { recursive: true });
  const prefix = `page-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const paths = Object.fromEntries(
    Object.keys(files).map((name) => {
      const path = join(TMP_DIR, `${prefix}-${name}`);
      return [name, path];
    })
  );

  for (const [name, source] of Object.entries(files)) {
    writeFileSync(requirePath(paths, name), typeof source === "function" ? source(paths) : source);
  }

  // Remove only the files created by this invocation so concurrent test runs
  // do not race against each other by deleting the shared TMP_DIR.
  return fn(paths).finally(() => {
    for (const filePath of Object.values(paths)) {
      try {
        rmSync(filePath, { force: true });
      } catch {
        /* cleanup failure is non-critical */
      }
    }
  });
}

function withTmpPage(source: string, fn: (path: string) => Promise<void>): Promise<void> {
  return withTmpFiles({ "page.tsx": source }, async (paths) => fn(requirePath(paths, "page.tsx")));
}

describe("furin-dev-page React singleton", () => {
  test("useState from virtual namespace is the same reference as the main process useState", () =>
    withTmpPage(
      `import { useState } from "react";
       export function getUseState() { return useState; }
       export default function Page() { const [v] = useState(0); return <span>{v}</span>; }`,
      async (pagePath) => {
        const mod = await import(`${pagePath}?furin-server&t=${Date.now()}`);
        const pageUseState = mod.getUseState();
        expect(pageUseState).toBe(mainUseState);
      }
    ));

  test("createContext from virtual namespace is the same reference as the main process createContext", () =>
    withTmpPage(
      `import { createContext } from "react";
       export function getCreateContext() { return createContext; }
       export default function Page() { return <div />; }`,
      async (pagePath) => {
        const mod = await import(`${pagePath}?furin-server&t=${Date.now()}`);
        expect(mod.getCreateContext()).toBe(mainCreateContext);
      }
    ));

  test("SSR rendering of a page with useState does not throw 'dispatcher is null'", () =>
    withTmpPage(
      `import { useState } from "react";
       export default function Page() {
         const [count] = useState(42);
         return <div data-count={count}>{count}</div>;
       }`,
      async (pagePath) => {
        const mod = await import(`${pagePath}?furin-server&t=${Date.now()}`);
        // renderToString sets up the dispatcher — this must not throw
        expect(() => renderToString(createElement(mod.default))).not.toThrow();
      }
    ));

  test("SSR rendering of a page with useContext does not throw 'dispatcher is null'", () =>
    withTmpPage(
      `import { useContext, createContext } from "react";
       const Ctx = createContext("hello");
       export default function Page() {
         const value = useContext(Ctx);
         return <span>{value}</span>;
       }`,
      async (pagePath) => {
        const mod = await import(`${pagePath}?furin-server&t=${Date.now()}`);
        expect(() => renderToString(createElement(mod.default))).not.toThrow();
      }
    ));

  test("a page that re-imports with a new timestamp (HMR simulation) still uses the correct instance", () =>
    withTmpPage(
      `import { useState } from "react";
       export function getUseState() { return useState; }
       export default function Page() { const [v] = useState(0); return <span>{v}</span>; }`,
      async (pagePath) => {
        // First load
        const mod1 = await import(`${pagePath}?furin-server&t=${Date.now()}`);
        // Second load (simulates HMR — new timestamp forces cache bypass)
        await new Promise((r) => setTimeout(r, 1));
        const mod2 = await import(`${pagePath}?furin-server&t=${Date.now()}`);

        expect(mod1.getUseState()).toBe(mainUseState);
        expect(mod2.getUseState()).toBe(mainUseState);
        // SSR must not throw on either load
        expect(() => renderToString(createElement(mod2.default))).not.toThrow();
      }
    ));

  test("SSR rendering of a page with a transitive local component using useState does not throw", () =>
    withTmpFiles(
      {
        "page.tsx": (paths) => `import { Widget } from ${JSON.stringify(paths["widget.tsx"])};
          export default function Page() {
            return <Widget />;
          }`,
        "widget.tsx": `import { useState } from "react";
          export function Widget() {
            const [count] = useState(1);
            return <div data-count={count}>{count}</div>;
          }`,
      },
      async (paths) => {
        const mod = await import(`${paths["page.tsx"]}?furin-server&t=${Date.now()}`);
        expect(() => renderToString(createElement(mod.default))).not.toThrow();
      }
    ));

  test("SSR rendering of nested layouts after root reload keeps hook components on the shared React instance", () =>
    withTmpFiles(
      {
        "root.tsx": `import { createRoute } from "@teyik0/furin/client";
          export const route = createRoute({
            layout: ({ children }) => <div data-root="yes">{children}</div>,
          });`,
        "_route.tsx": (paths) => `import { createRoute } from "@teyik0/furin/client";
          import { Nav } from ${JSON.stringify(paths["nav.tsx"])};
          import { route as rootRoute } from ${JSON.stringify(paths["root.tsx"])};
          export const route = createRoute({
            parent: rootRoute,
            layout: ({ children }) => (
              <section>
                <Nav />
                {children}
              </section>
            ),
          });`,
        "nav.tsx": `import { useState } from "react";
          export function Nav() {
            const [open] = useState(true);
            return <button data-open={String(open)}>nav</button>;
          }`,
        "page.tsx": (paths) => `import { route } from ${JSON.stringify(paths["_route.tsx"])};
          export default route.page({
            component: () => <main>docs page</main>,
          });`,
      },
      async (paths) => {
        const rootPath = requirePath(paths, "root.tsx");
        const routePath = requirePath(paths, "_route.tsx");
        const pagePath = requirePath(paths, "page.tsx");
        const rootMod = await import(rootPath);
        const routeMod = await import(routePath);
        const pageMod = await import(`${pagePath}?furin-server&t=${Date.now()}`);

        const element = buildElement(
          {
            page: pageMod.default,
            routeChain: [rootMod.route, routeMod.route],
          } as Parameters<typeof buildElement>[0],
          {},
          rootMod.route
        );

        expect(() => renderToString(element)).not.toThrow();
      }
    ));
});
