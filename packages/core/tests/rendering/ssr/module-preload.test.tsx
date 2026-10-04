import { afterEach, describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import { clientModule, preloadClientModule } from "../../../src/client.ts";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
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
