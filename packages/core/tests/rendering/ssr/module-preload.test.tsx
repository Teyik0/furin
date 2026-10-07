import { afterEach, describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import { clientModule, preloadClientModule } from "../../../src/client.ts";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
import { createInstance, withInstance } from "../../../src/server/instance.ts";
import { renderToHTML } from "../../../src/server/render/index.ts";
import { generateProdIndexHtml } from "../../../src/server/render/shell.ts";
import { renderSSR } from "../../../src/server/render/ssr.ts";
import {
  __resetTemplateState,
  setProductionPreloadManifest,
  setProductionTemplateContent,
} from "../../../src/server/render/template.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const SCENE_KEY = "__FURIN_CLIENT_MODULE_scene__";
const MODULE_PRELOAD_RE = /<link rel="modulepreload"[^>]*?href="([^"]+)"/g;

function createContext(): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/canvas",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/canvas"),
    set: { headers: {} as HTTPHeaders },
  } as Context;
}

function createCanvasRoute(preloadScene: boolean): { root: RootLayout; route: ResolvedRoute } {
  const scene = clientModule(() => Promise.resolve({}), SCENE_KEY);
  const rootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Scripts />
        </body>
      </html>
    ));
  const rootRoute = adaptDefinedLayout(rootTerminal, undefined);
  const terminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .page(() => {
      if (preloadScene) {
        preloadClientModule(scene);
      }
      return <canvas />;
    });
  const page = adaptDefinedPage(terminal, rootRoute);
  return {
    root: { path: "/root.tsx", route: rootRoute },
    route: {
      mode: "ssr",
      page,
      path: "/canvas.tsx",
      pattern: "/canvas",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    },
  };
}

function headPreloads(html: string): string[] {
  const head = html.slice(0, html.indexOf("</head>"));
  return [...head.matchAll(MODULE_PRELOAD_RE)].map((match) => match[1] as string);
}

afterEach(() => {
  __resetTemplateState();
});

describe("module preloading", () => {
  test("keeps assets already rooted at the physical mount of a root plugin", async () => {
    const instance = createInstance("", "/pages");
    instance.prefix = "/outer";
    await withInstance(instance, async () => {
      setProductionTemplateContent(
        '<script data-furin-framework-module="" type="module" src="/outer/_furin/events/client.js"></script>' +
          '<script type="module" src="/_client/entry.js"></script>'
      );
      setProductionPreloadManifest({
        modules: { [SCENE_KEY]: ["/outer/_client/scene.js"] },
        routes: { "/canvas": ["/_client/canvas.js"] },
      });
      const { root, route } = createCanvasRoute(true);
      const { html } = await renderToHTML(route, createContext(), root);
      expect(headPreloads(html).toSorted()).toEqual([
        "/outer/_client/canvas.js",
        "/outer/_client/scene.js",
      ]);
      expect(html).toContain('src="/outer/_client/entry.js"');
      expect(html).toContain('src="/outer/_furin/events/client.js"');
      expect(html).not.toContain("/outer/outer/");
    });
  });

  test.each(["buffered", "streaming"])(
    "rebases %s production assets and explicit client preloads under nested mounts",
    async (mode) => {
      const instance = createInstance("/admin", "/pages");
      instance.prefix = "/outer/inner/admin";
      await withInstance(instance, async () => {
        setProductionTemplateContent(
          '<link rel="stylesheet" href="/admin/_client/style.css"><link rel="icon" href="/admin/favicon.ico">' +
            '<script data-furin-framework-module="" type="module" src="/admin/_furin/events/client.js"></script>' +
            '<script type="module" src="/admin/_client/entry.js"></script>'
        );
        setProductionPreloadManifest({
          modules: { [SCENE_KEY]: ["/admin/_client/scene.js", "/admin/_client/shared.js"] },
          routes: { "/canvas": ["/admin/_client/canvas.js", "/admin/_client/shared.js"] },
        });
        const { root, route } = createCanvasRoute(true);
        const html =
          mode === "buffered"
            ? (await renderToHTML(route, createContext(), root)).html
            : await (await renderSSR(route, createContext(), root, undefined)).text();
        expect(headPreloads(html).toSorted()).toEqual([
          "/outer/inner/admin/_client/canvas.js",
          "/outer/inner/admin/_client/scene.js",
          "/outer/inner/admin/_client/shared.js",
        ]);
        expect(html).toContain('src="/outer/inner/admin/_client/entry.js"');
        expect(html).toContain('src="/outer/inner/admin/_furin/events/client.js"');
        expect(html).toContain('href="/outer/inner/admin/_client/style.css"');
        expect(html).toContain('href="/outer/inner/admin/favicon.ico"');
        expect(html).toContain('name="furin-base-path" content="/outer/inner/admin"');
      });
    }
  );

  function installBuild(): void {
    setProductionTemplateContent(
      generateProdIndexHtml("/_client/entry.js", [], "build", undefined, false)
    );
    setProductionPreloadManifest({
      modules: { [SCENE_KEY]: ["/_client/scene.js", "/_client/shared.js"] },
      routes: { "/canvas": ["/_client/canvas.js", "/_client/shared.js"] },
    });
  }

  test("a buffered render hoists route and client module preloads into <head> once", async () => {
    installBuild();
    const { root, route } = createCanvasRoute(true);

    const { html } = await renderToHTML(route, createContext(), root);

    expect(headPreloads(html).toSorted()).toEqual([
      "/_client/canvas.js",
      "/_client/scene.js",
      "/_client/shared.js",
    ]);
    expect(html.match(MODULE_PRELOAD_RE)).toHaveLength(3);
  });

  test("a streaming render hoists route and client module preloads into <head> once", async () => {
    installBuild();
    const { root, route } = createCanvasRoute(true);

    const response = await renderSSR(route, createContext(), root, undefined);
    const html = await response.text();

    expect(headPreloads(html).toSorted()).toEqual([
      "/_client/canvas.js",
      "/_client/scene.js",
      "/_client/shared.js",
    ]);
    expect(html.match(MODULE_PRELOAD_RE)).toHaveLength(3);
  });

  test("an empty manifest without explicit client preloads emits no module preloads", async () => {
    setProductionTemplateContent(
      generateProdIndexHtml("/_client/entry.js", [], "build", undefined, false)
    );
    setProductionPreloadManifest({ modules: {}, routes: {} });
    const { root, route } = createCanvasRoute(false);

    const { html } = await renderToHTML(route, createContext(), root);
    expect(headPreloads(html)).toEqual([]);

    const response = await renderSSR(route, createContext(), root, undefined);
    expect(headPreloads(await response.text())).toEqual([]);
  });
});
