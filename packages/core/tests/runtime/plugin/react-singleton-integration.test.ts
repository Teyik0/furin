/**
 * Integration test: pages loaded via furin-dev-page namespace must share the
 * same React instance as react-dom/server.
 *
 * Regression test for: "dispatcher is null" hook crash on HMR.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createElement, createContext as mainCreateContext, useState as mainUseState } from "react";
import { renderToString } from "react-dom/server";
import { registerDevPagePlugin } from "../../../src/server/dev-page-plugin.ts";
import { withDocumentState } from "../../../src/server/render/document.tsx";
import { buildElement } from "../../../src/server/render/element.tsx";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { requireTmpPath, withTmpFiles, withTmpPage } from "../../support/tmp-files";

registerDevPagePlugin();

const CORE_DIR = import.meta.dir.replace(/\/tests(?:\/.*)?$/, "");
const TMP_DIR = join(CORE_DIR, ".tmp-tests", "react-singleton");

describe("furin-dev-page React singleton", () => {
  test("useState from virtual namespace is the same reference as the main process useState", () =>
    withTmpPage(
      TMP_DIR,
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
      TMP_DIR,
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
      TMP_DIR,
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
      TMP_DIR,
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
      TMP_DIR,
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
      TMP_DIR,
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
      TMP_DIR,
      {
        "_route.tsx": (paths) => `import { defineRoute } from "@teyik0/furin";
          import { Nav } from ${JSON.stringify(paths["nav.tsx"])};
          import { route as rootRoute } from ${JSON.stringify(paths["root.tsx"])};
          export const route = defineRoute()
            .config({ layout: rootRoute, mode: "ssr" })
            .layout(({ children }) => (
              <section>
                <Nav />
                {children}
              </section>
            ));`,
        "nav.tsx": `import { useState } from "react";
          export function Nav() {
            const [open] = useState(true);
            return <button data-open={String(open)}>nav</button>;
          }`,
        "page.tsx": (paths) => `import { defineRoute } from "@teyik0/furin";
          import { route as parentRoute } from ${JSON.stringify(paths["_route.tsx"])};
          export const route = defineRoute()
            .config({ layout: parentRoute, mode: "ssg" })
            .page(() => <main>docs page</main>);`,
        "root.tsx": `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
          export const route = defineRootRoute()
            .config({ mode: "ssr" })
            .layout(({ children }) => <html lang="en"><head><HeadContent /></head><body><div data-root="yes">{children}</div><Scripts /></body></html>);`,
      },
      async (paths) => {
        const rootPath = requireTmpPath(paths, "root.tsx");
        const routePath = requireTmpPath(paths, "_route.tsx");
        const pagePath = requireTmpPath(paths, "page.tsx");
        const rootMod = await import(rootPath);
        const routeMod = await import(routePath);
        const pageMod = await import(`${pagePath}?furin-server&t=${Date.now()}`);
        const root = adaptDefinedLayout(rootMod.route, undefined);
        const layout = adaptDefinedLayout(routeMod.route, root);
        const page = adaptDefinedPage(pageMod.route, layout);

        const element = buildElement(
          {
            page,
            routeChain: [root, layout, page._route],
          } as Parameters<typeof buildElement>[0],
          {},
          root
        );

        expect(() =>
          renderToString(
            withDocumentState(
              element,
              {
                buildId: undefined,
                entryModule: undefined,
                faviconHref: undefined,
                staticMode: false,
                stylesheets: [],
              },
              undefined,
              undefined
            )
          )
        ).not.toThrow();
      }
    ));
});
