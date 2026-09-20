import { describe, expect, test } from "bun:test";
import "../../setup/evlog-mock";

import type { Context } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import { HeadContent, Scripts } from "../../../src/client/document.tsx";
import { defer } from "../../../src/client.ts";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
import { renderToHTML } from "../../../src/server/render/index.ts";
import { prepareRender } from "../../../src/server/render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import type { ResolvedRoute } from "../../../src/server/router/types.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

function createLoaderContext(): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/account",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/account"),
    set: { headers: {} as HTTPHeaders },
  } as Context;
}

describe("SSR head context", () => {
  test("reuses synchronous loader data as the component context", async () => {
    const rootTerminal = defineRootRoute()
      .config({ mode: "ssr" })
      .layout(({ children }) => children);
    const rootRoute = adaptDefinedLayout(rootTerminal, undefined);
    const terminal = defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .page(() => null);
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "ssr",
      page,
      path: "/account.tsx",
      pattern: "/account",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const syncData = { params: {}, path: "/account", query: {} };

    const prepared = await prepareRender(
      route,
      createLoaderContext(),
      { path: "/", route: rootRoute },
      undefined,
      false,
      { deferredPromises: undefined, headers: {}, syncData, type: "data" }
    );

    if (prepared instanceof Response) {
      throw new Error("Expected a prepared render result.");
    }
    expect(prepared.componentProps).toBe(syncData);
  });

  test("keeps deferred and request data out of head while exposing them to the page", async () => {
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
    let headReceivedDeferredData = false;
    let headReceivedRequestData = false;
    let pageReceivedDeferredData = false;
    let pageReceivedRequestData = false;
    const terminal = defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => defer({ catalog: "Shoes", stock: Promise.resolve(42) }))
      .head((props) => {
        headReceivedDeferredData = "stock" in props;
        headReceivedRequestData = "requestData" in props;
        return {};
      })
      .page((props) => {
        pageReceivedDeferredData = "stock" in props;
        pageReceivedRequestData = "requestData" in props;
        return null;
      });
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "ssr",
      page,
      path: "/account.tsx",
      pattern: "/account",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };

    await renderToHTML(route, createLoaderContext(), { path: "/", route: rootRoute });

    expect(headReceivedDeferredData).toBe(false);
    expect(headReceivedRequestData).toBe(false);
    expect(pageReceivedDeferredData).toBe(true);
    expect(pageReceivedRequestData).toBe(true);
  });
});
