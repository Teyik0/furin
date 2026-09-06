import { describe, expect, test } from "bun:test";
import type { Context } from "elysia";
import "../../setup/evlog-mock";

import { createElement, Suspense } from "react";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";

const { join } = await import("node:path");
const { defer } = await import("../../../src/client.ts");
const { renderSSR } = await import("../../../src/server/render/index.ts");
const { setProductionTemplateContent } = await import("../../../src/server/render/template.ts");
const { scanPages } = await import("../../../src/server/router/discovery.ts");
const { __setDevMode } = await import("../../../src/server/runtime-env.ts");
const { Await } = await import("../../../src/shared/await.tsx");

const TEST_TEMPLATE =
  '<!DOCTYPE html><html><head><!--ssr-head--></head><body><div id="root"><!--ssr-outlet--></div><script type="module" src="/_hydrate.js"></script></body></html>';

function asResolvedRoute(route: unknown): ResolvedRoute {
  return route as ResolvedRoute;
}

function createMockLoaderContext(overrides: Partial<Context>): Context {
  return {
    cookie: {},
    headers: {},
    params: {},
    path: "/test",
    query: {},
    redirect: (url: string) => new Response(null, { headers: { Location: url }, status: 302 }),
    request: new Request("http://localhost/test"),
    set: { headers: {} },
    ...overrides,
  } as unknown as Context;
}

async function getSsrFixtureRoute(): Promise<{ root: RootLayout; ssrRoute: ResolvedRoute }> {
  const result = await scanPages(join(import.meta.dir, "../../fixtures/pages/default"));
  const ssrRoute = result.routes.find((route) => route.pattern === "/ssr-page");
  if (ssrRoute === undefined) {
    throw new Error("Route /ssr-page not found");
  }
  return { root: result.root, ssrRoute };
}

describe.serial("renderSSR deferred Suspense scenarios", () => {
  test.serial("renderSSR streams deferred chunks in settlement order", async () => {
    __setDevMode(false);
    setProductionTemplateContent(TEST_TEMPLATE);
    const fixture = await getSsrFixtureRoute();
    const customRoute = asResolvedRoute({
      ...fixture.ssrRoute,
      page: {
        ...fixture.ssrRoute.page,
        loader: () =>
          defer({
            fast: new Promise((resolve) => setTimeout(() => resolve("fast-value"), 10)),
            slow: new Promise((resolve) => setTimeout(() => resolve("slow-value"), 80)),
          }),
      },
    });

    const response = await renderSSR(
      customRoute,
      createMockLoaderContext({ path: "/ssr-page" }),
      fixture.root,
      undefined
    );
    const html = await response.text();
    const firstPushIdx = html.indexOf("window.__FURIN_ROUTE_FRAME_STREAM__.push(");
    const fastIdx = html.indexOf("fast", firstPushIdx);
    const slowIdx = html.indexOf("slow", firstPushIdx);

    expect(fastIdx).toBeGreaterThan(-1);
    expect(slowIdx).toBeGreaterThan(-1);
    expect(fastIdx).toBeLessThan(slowIdx);
    expect(html.indexOf("window.__FURIN_ROUTE_FRAME_STREAM__=")).toBeLessThan(
      html.indexOf('data-furin-entry=""')
    );
    expect(html.lastIndexOf("window.__FURIN_ROUTE_FRAME_STREAM__.push(")).toBeLessThan(
      html.indexOf("</body>")
    );
    expect(html.indexOf("</body>")).toBeLessThan(html.indexOf("</html>"));
    expect(html.match(/id="__FURIN_ROUTE_FRAMES__"/g)).toHaveLength(1);
  });

  test.serial("renderSSR resolves deferred Suspense content without aborting SSR", async () => {
    __setDevMode(false);
    setProductionTemplateContent(TEST_TEMPLATE);
    const fixture = await getSsrFixtureRoute();
    const customRoute = asResolvedRoute({
      ...fixture.ssrRoute,
      page: {
        ...fixture.ssrRoute.page,
        component: (props: { [key: string]: unknown }) => {
          const slow = props.slow as Promise<unknown>;
          return createElement(
            Suspense,
            { fallback: createElement("span", null, "loading") },
            createElement(Await<unknown>, {
              // biome-ignore lint/correctness/noChildrenProp: render-prop pattern — children is a function, not a ReactNode
              children: (value: unknown) => createElement("span", null, String(value)),
              resolve: slow,
            })
          );
        },
        loader: () =>
          defer({
            slow: new Promise((resolve) => setTimeout(() => resolve("done"), 50)),
          }),
      },
    });

    const response = await renderSSR(
      customRoute,
      createMockLoaderContext({ path: "/ssr-page" }),
      fixture.root,
      undefined
    );
    const html = await response.text();

    expect(html).toContain("done");
    expect(html).toContain("window.__FURIN_ROUTE_FRAME_STREAM__.push");
    expect(html).not.toContain("Switched to client rendering because the server rendering aborted");
  });
});
