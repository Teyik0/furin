import { expect, test } from "bun:test";
import { type AnyElysia, Elysia } from "elysia";
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
import { furin } from "../../../src/furin.ts";
import {
  __resetCompileContext,
  __setCompileContext,
  type CompiledModule,
} from "../../../src/server/internal.ts";
import { documentAssetsFromTemplate } from "../../../src/server/render/template.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
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

interface RouteTerminal {
  elysia: AnyElysia;
}

const createDashboardRoot = (load: (path: string) => void) =>
  defineRootRoute()
    .config({ mode: "ssr" })
    .loader(({ path }) => {
      load(path);
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
const createLibraryLayout = () =>
  defineRoute("/loader-fallback/library/_route")
    .config({ mode: "ssr" })
    .loader(() => ({ section: "Library" }))
    .layout(({ children, section }) => <section data-section={section}>{children}</section>);

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/loader-fallback/library/_route": {
      kind: "layout";
      parent: ReturnType<typeof createDashboardRoot>;
      pathParams: NonNullable<unknown>;
    };
    "/loader-fallback/library/page": {
      kind: "page";
      parent: ReturnType<typeof createLibraryLayout>;
      pathParams: NonNullable<unknown>;
    };
  }
}

/**
 * Serves `/missing` and `/ok` through a production `furin()`. Both pages sit
 * under a `library/` layout; the root and the library directory each declare
 * `error.tsx` and `not-found.tsx`, as the build would record them.
 */
async function mountBoundaryApp(
  template: string,
  root: RouteTerminal,
  library: RouteTerminal,
  pages: ReadonlyMap<string, RouteTerminal>
): Promise<AnyElysia> {
  const pagesDir = `/furin-virtual/${crypto.randomUUID()}`;
  const libraryDir = `${pagesDir}/library`;
  const modules: { [path: string]: CompiledModule } = {
    [`${libraryDir}/_route.tsx`]: { route: library },
    [`${libraryDir}/error.tsx`]: { default: Unavailable },
    [`${libraryDir}/not-found.tsx`]: { default: Missing },
    [`${pagesDir}/error.tsx`]: { default: Unavailable },
    [`${pagesDir}/not-found.tsx`]: { default: Missing },
    [`${pagesDir}/root.tsx`]: { route: root },
  };
  const segmentBoundaries = [
    {
      depth: 0,
      errorPath: `${pagesDir}/error.tsx`,
      notFoundPath: `${pagesDir}/not-found.tsx`,
      path: pagesDir,
    },
    {
      depth: 1,
      errorPath: `${libraryDir}/error.tsx`,
      notFoundPath: `${libraryDir}/not-found.tsx`,
      path: libraryDir,
    },
  ];
  const nativeRoutes = new Elysia();
  const routes = [...pages].map(([pattern, route]) => {
    const path = `${libraryDir}${pattern}.tsx`;
    modules[path] = { route };
    nativeRoutes.use(new Elysia({ prefix: pattern }).use(route.elysia));
    return { mode: "ssr" as const, path, pattern };
  });
  __setCompileContext({
    buildId: "",
    modules,
    nativeRoutes,
    rootConventions: {
      errorPath: `${pagesDir}/error.tsx`,
      notFoundPath: `${pagesDir}/not-found.tsx`,
    },
    rootPath: `${pagesDir}/root.tsx`,
    routeMetadata: Object.fromEntries(routes.map(({ path }) => [path, { segmentBoundaries }])),
    routes,
    adapter: {
      capabilities: { assets: "platform", publicCache: "framework", websocket: true },
      name: "test",
    },
    templateHtml: template,
  });
  return new Elysia().use(await furin({ pagesDir }));
}

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
    const template = "<!DOCTYPE html><html><head></head><body></body></html>";
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
      const layout = createDashboardRoot((path) => {
        rootCalls += 1;
        if (rootFailure && path === "/missing") {
          fail();
        }
      });
      const nestedDefinition = createLibraryLayout();
      const root = {
        error: Unavailable,
        notFound: Missing,
        path: "/root.tsx",
        route: adaptDefinedLayout(layout, undefined),
      };
      const nested = adaptDefinedLayout(nestedDefinition, root.route);
      const definitions = new Map<string, RouteTerminal>();
      const routes = ["/missing", "/ok"].map((pattern) => {
        const definition = defineRoute("/loader-fallback/library/page")
          .config({ mode: "ssr" })
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
        definitions.set(pattern, definition);
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
      const app = await mountBoundaryApp(template, layout, nestedDefinition, definitions);
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
              initialMatch,
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
      __resetCompileContext();
      await uninstallDom();
    }
  }
);
