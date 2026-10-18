import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Elysia } from "elysia";
import { act, createElement } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import {
  DocumentProvider,
  type DocumentState,
  HeadContent,
  Scripts,
} from "../../../src/client/document.tsx";
import { findRouteFailure, Link, RouterProvider } from "../../../src/client/link.tsx";
import type { ClientRoute, LoadedClientRoute } from "../../../src/client/router/types.ts";
import { defineRootRoute, defineRoute } from "../../../src/define-route.ts";
import { renderSSR } from "../../../src/server/render/ssr.ts";
import {
  documentAssetsFromTemplate,
  setProductionTemplatePath,
} from "../../../src/server/render/template.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createDataEndpoint } from "../../../src/server/router/plugin.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { notFound } from "../../../src/shared/not-found.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const Missing = () => (
  <main>
    <h1>Missing resource</h1>
    <Link to={"/ok" as string}>Go home</Link>
  </main>
);
const Unavailable = () => (
  <main>
    <h1>Unavailable resource</h1>
    <Link to={"/ok" as string}>Go home</Link>
  </main>
);

test.each([
  [404, false],
  [503, false],
  [404, true],
  [503, true],
] as const)(
  "SSR loader fallback hydrates and navigates with valid layout data (status %s, root failure %s)",
  async (status, rootFailure) => {
    const previousDevMode = IS_DEV;
    const originalFetch = globalThis.fetch;
    let hydrated: Root | undefined;
    const directory = mkdtempSync(join(tmpdir(), "furin-loader-hydration-"));
    const template = "<!DOCTYPE html><html><head></head><body></body></html>";
    const templatePath = join(directory, "index.html");
    await Bun.write(templatePath, template);
    setProductionTemplatePath(templatePath);
    __setDevMode(false);
    installDom();
    resetDomState();
    try {
      const fail = () => {
        if (status === 404) {
          notFound({ data: { slug: "gone" }, message: "Missing resource" });
        }
        throw new Response("Resource unavailable", { status });
      };
      let rootCalls = 0;
      const layout = defineRootRoute()
        .config({ mode: "ssr" })
        .loader(({ path }) => {
          rootCalls += 1;
          if (rootFailure && path === "/missing") {
            fail();
          }
          return { dashboard: { settings: { theme: "forest" } } };
        })
        .layout(({ children, dashboard }) => (
          <html lang="en">
            <head>
              <HeadContent />
            </head>
            <body data-theme={dashboard.settings.theme}>
              {children}
              <Scripts />
            </body>
          </html>
        ));
      const nestedDefinition = defineRoute()
        .config({ layout, mode: "ssr" })
        .loader(() => ({ section: "Library" }))
        .layout(({ children, section }) => <section data-section={section}>{children}</section>);
      const root = {
        error: Unavailable,
        notFound: Missing,
        path: "/root.tsx",
        route: adaptDefinedLayout(layout, undefined),
      };
      const nested = adaptDefinedLayout(nestedDefinition, root.route);
      const routes = ["/missing", "/ok"].map((pattern) => {
        const definition = defineRoute()
          .config({ layout: nestedDefinition, mode: "ssr" })
          .loader(async ({ dashboard }) => {
            await dashboard;
            if (pattern === "/missing") {
              fail();
            }
            return {};
          })
          .page(() => (
            <main>
              <p>Ready</p>
              <Link to={"/missing" as string}>Open missing</Link>
            </main>
          ));
        const page = adaptDefinedPage(definition, nested);
        return {
          mode: "ssr" as const,
          page,
          path: `${pattern}.tsx`,
          pattern,
          routeChain: collectRouteChainFromRoute(page._route),
          // The nested boundary sits inside the library layout, so a page
          // failure keeps both layouts.
          segmentBoundaries: [
            { depth: 0, path: "/", error: Unavailable, notFound: Missing },
            { depth: 1, path: "/library", error: Unavailable, notFound: Missing },
          ],
          error: Unavailable,
          notFound: Missing,
        };
      });
      const [missing] = routes;
      if (!missing) {
        throw new Error("Missing test route");
      }
      const app = new Elysia()
        .use(createDataEndpoint(routes, root))
        .get("/missing", (context: Context) => renderSSR(missing, context, root, undefined));
      const response = await app.handle(new Request("http://localhost:3000/missing"));
      expect(response.status).toBe(status);
      const html = await response.text();
      window.history.replaceState(null, "", "/missing");
      document.write(html.trimEnd());
      const json = document.getElementById("__FURIN_DATA__")?.textContent;
      const frames = document.querySelector<HTMLTemplateElement>("#__FURIN_ROUTE_FRAMES__");
      const data = json
        ? JSON.parse(json)
        : (
            await parseDeferredNdjson(
              new Blob([frames?.content.textContent ?? ""]).stream(),
              undefined
            )
          ).syncData;
      const clientRoutes: ClientRoute[] = routes.map((route) => ({
        pattern: route.pattern,
        regex: new RegExp(`^${route.pattern}$`),
        segmentBoundaries: route.segmentBoundaries,
        load: async () => ({
          default: { component: route.page.component, _route: route.page._route },
        }),
      }));
      const [initialRoute] = clientRoutes;
      if (!initialRoute) {
        throw new Error("Missing initial client route");
      }
      const initialMatch: LoadedClientRoute = {
        ...initialRoute,
        component: missing.page.component,
        pageRoute: missing.page._route,
      };
      const documentState: DocumentState = {
        assets: documentAssetsFromTemplate(template),
        dataJson: json ?? undefined,
        head: JSON.parse(document.getElementById("__FURIN_HEAD__")?.textContent ?? "{}"),
        syncJson: undefined,
      };
      const recoverable: unknown[] = [];
      const failure = findRouteFailure(data);
      await act(() => {
        hydrated = hydrateRoot(
          document,
          createElement(
            DocumentProvider,
            { value: documentState },
            createElement(RouterProvider, {
              autoRefresh: false,
              basePath: "",
              defaultPreload: "intent",
              defaultPreloadDelay: 50,
              defaultPreloadStaleTime: 30_000,
              initialData: data,
              initialDigest: failure?.status === "error" ? failure.error.digest : undefined,
              initialError: failure?.status === "error" ? failure.error : undefined,
              initialMatch,
              initialNotFound: failure?.status === "notFound" ? failure.error : undefined,
              prefetchCacheSize: 50,
              root: root.route,
              routes: clientRoutes,
            })
          ),
          { onRecoverableError: (error) => recoverable.push(error) }
        );
      });
      expect(recoverable).toEqual([]);
      expect(document.body.textContent).toContain(
        status === 404 ? "Missing resource" : "Unavailable resource"
      );
      expect(document.body.getAttribute("data-theme")).toBe(rootFailure ? null : "forest");
      expect(document.querySelector("[data-section]")?.getAttribute("data-section")).toBe(
        rootFailure ? undefined : "Library"
      );
      expect(rootCalls).toBe(1);
      globalThis.fetch = ((input, init) => {
        const { signal: _signal, ...options } = init ?? {};
        return app.handle(new Request(new URL(String(input), window.location.origin), options));
      }) as typeof fetch;
      await act(async () => {
        document
          .querySelector<HTMLAnchorElement>('a[href="/ok"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
        await Bun.sleep(20);
      });
      expect(window.location.pathname).toBe("/ok");
      expect(document.body.textContent).toContain("Ready");
      expect(document.body.getAttribute("data-theme")).toBe("forest");
      expect(rootCalls).toBe(2);
      await act(async () => {
        document
          .querySelector<HTMLAnchorElement>('a[href="/missing"]')
          ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
        await Bun.sleep(20);
      });
      expect(window.location.pathname).toBe("/missing");
      expect(document.body.textContent).toContain(
        status === 404 ? "Missing resource" : "Unavailable resource"
      );
      expect(document.body.getAttribute("data-theme")).toBe(rootFailure ? null : "forest");
      expect(rootCalls).toBe(3);
    } finally {
      if (hydrated) {
        await act(() => hydrated?.unmount());
      }
      globalThis.fetch = originalFetch;
      __setDevMode(previousDevMode);
      setProductionTemplatePath(null);
      rmSync(directory, { recursive: true, force: true });
      await uninstallDom();
    }
  }
);
