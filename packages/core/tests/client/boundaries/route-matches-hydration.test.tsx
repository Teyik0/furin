import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyElysia, type Context, Elysia } from "elysia";
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
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import type { ErrorProps } from "../../../src/shared/error.ts";
import { type NotFoundProps, notFound } from "../../../src/shared/not-found.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { installDom, resetDomState, uninstallDom } from "../../support/dom.ts";

const TEMPLATE = "<!DOCTYPE html><html><head></head><body></body></html>";

const RootError = ({ error }: ErrorProps) => <p data-fallback="root-error">{error.message}</p>;
const RootNotFound = ({ error }: NotFoundProps) => (
  <p data-fallback="root-not-found">{error.message}</p>
);
const ShopError = ({ error }: ErrorProps) => <p data-fallback="shop-error">{error.message}</p>;
const ShopNotFound = ({ error }: NotFoundProps) => (
  <p data-fallback="shop-not-found">{error.message}</p>
);

const SHOP_PAGES = ["/shop/ok", "/shop/error", "/shop/missing", "/shop/broken"];

const rootDefinition = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <nav>
          {SHOP_PAGES.map((href) => (
            <Link key={href} to={href as string}>
              {href}
            </Link>
          ))}
        </nav>
        <div data-layout="root">{children}</div>
        <Scripts />
      </body>
    </html>
  ));

const root: RootLayout = {
  error: RootError,
  notFound: RootNotFound,
  path: "/pages/root.tsx",
  route: adaptDefinedLayout(rootDefinition, undefined),
};

const shopDefinition = defineRoute()
  .config({ layout: rootDefinition, mode: "ssr" })
  .loader(({ path }) => {
    if (path === "/shop/broken") {
      throw new Response("Shop unavailable", { status: 503 });
    }
    return { title: "Shop" };
  })
  .layout(({ children, ...props }) => (
    <section
      data-layout="shop"
      data-props={JSON.stringify({ keys: Object.keys(props).sort(), title: props.title })}
    >
      {children}
    </section>
  ));
const shop = adaptDefinedLayout(shopDefinition, root.route);

const BOUNDARIES = [
  { depth: 0, error: RootError, notFound: RootNotFound, path: "/pages" },
  { depth: 1, error: ShopError, notFound: ShopNotFound, path: "/pages/shop" },
];

interface TestRoute {
  client: LoadedClientRoute;
  server: ResolvedRoute;
}

function toTestRoute(
  pattern: string,
  page: ReturnType<typeof adaptDefinedPage>,
  segmentBoundaries: ResolvedRoute["segmentBoundaries"]
): TestRoute {
  const client: ClientRoute = {
    load: () => Promise.resolve({ default: { _route: page._route, component: page.component } }),
    pattern,
    regex: new RegExp(`^${pattern}$`),
    segmentBoundaries,
  };
  return {
    client: { ...client, component: page.component, pageRoute: page._route },
    server: {
      mode: "ssr",
      page,
      path: `/pages${pattern}.tsx`,
      pattern,
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries,
    },
  };
}

function shopPage(pattern: string): TestRoute {
  const definition = defineRoute()
    .config({ layout: shopDefinition, mode: "ssr" })
    .loader(({ path }) => {
      if (path === "/shop/error") {
        throw new Response("Page unavailable", { status: 503 });
      }
      if (path === "/shop/missing") {
        notFound({ message: "No such product" });
      }
      // Same name as the layout field: the layout must keep its own value.
      return { title: "Page title" };
    })
    .page(({ title }) => <p data-page="shop">{title}</p>);
  return toTestRoute(pattern, adaptDefinedPage(definition, shop), BOUNDARIES);
}

let directory: string;
let previousDevMode: boolean;
let originalFetch: typeof fetch;
let hydrated: Root | undefined;

beforeEach(async () => {
  previousDevMode = IS_DEV;
  originalFetch = globalThis.fetch;
  directory = mkdtempSync(join(tmpdir(), "furin-route-matches-"));
  const templatePath = join(directory, "index.html");
  await Bun.write(templatePath, TEMPLATE);
  setProductionTemplatePath(templatePath);
  __setDevMode(false);
  installDom();
  resetDomState();
});

afterEach(async () => {
  if (hydrated) {
    await act(() => hydrated?.unmount());
    hydrated = undefined;
  }
  globalThis.fetch = originalFetch;
  __setDevMode(previousDevMode);
  setProductionTemplatePath(null);
  rmSync(directory, { force: true, recursive: true });
  await uninstallDom();
});

function createApp(routes: TestRoute[]): AnyElysia {
  return routes.reduce<AnyElysia>(
    (app, route) =>
      app.get(route.server.pattern, (context: Context) =>
        renderSSR(route.server, context, root, undefined)
      ),
    new Elysia().use(
      createDataEndpoint(
        routes.map((route) => route.server),
        root
      )
    )
  );
}

async function documentData(): Promise<Record<string, unknown>> {
  const json = document.getElementById("__FURIN_DATA__")?.textContent;
  if (json) {
    return JSON.parse(json);
  }
  const frames = document.querySelector<HTMLTemplateElement>("#__FURIN_ROUTE_FRAMES__");
  const parsed = await parseDeferredNdjson(
    new Blob([frames?.content.textContent ?? ""]).stream(),
    undefined
  );
  return parsed.syncData;
}

/** Server-renders `href`, then hydrates it the way the generated entry does. */
async function serverRenderAndHydrate(
  routes: TestRoute[],
  href: string
): Promise<{ recoverable: unknown[]; serverBody: string; status: number }> {
  const app = createApp(routes);
  const response = await app.handle(new Request(`http://localhost:3000${href}`));
  const html = await response.text();
  window.history.replaceState(null, "", href);
  document.write(html.trimEnd());
  const serverBody = document.body.innerHTML;
  const data = await documentData();
  const failure = findRouteFailure(data);
  const error = failure?.status === "error" ? failure.error : undefined;
  const initialMatch = routes.find((route) => route.server.pattern === href)?.client ?? null;
  const documentState: DocumentState = {
    assets: documentAssetsFromTemplate(TEMPLATE),
    dataJson: document.getElementById("__FURIN_DATA__")?.textContent ?? undefined,
    head: JSON.parse(document.getElementById("__FURIN_HEAD__")?.textContent ?? "{}"),
    syncJson: undefined,
  };
  globalThis.fetch = ((input, init) => {
    const { signal: _signal, ...options } = init ?? {};
    return app.handle(new Request(new URL(String(input), window.location.origin), options));
  }) as typeof fetch;
  const recoverable: unknown[] = [];
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
          initialDigest: error?.digest,
          initialError: error,
          initialMatch,
          initialNotFound: failure?.status === "notFound" ? failure.error : undefined,
          prefetchCacheSize: 50,
          root: root.route,
          routes: routes.map((route) => route.client),
        })
      ),
      { onRecoverableError: (cause) => recoverable.push(cause) }
    );
  });
  return { recoverable, serverBody, status: response.status };
}

async function clientNavigate(href: string): Promise<void> {
  await act(async () => {
    document
      .querySelector<HTMLAnchorElement>(`a[href="${href}"]`)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0, cancelable: true }));
    await Bun.sleep(20);
  });
  expect(window.location.pathname).toBe(href);
}

function shopLayoutProps(): unknown {
  const props = document.querySelector("[data-layout='shop']")?.getAttribute("data-props");
  return props ? JSON.parse(props) : undefined;
}

function fallback(): string | null | undefined {
  return document.querySelector("[data-fallback]")?.getAttribute("data-fallback");
}

const SHOP_LAYOUT_PROPS = { keys: ["params", "path", "query", "title"], title: "Shop" };

describe("route matches", () => {
  const routes = SHOP_PAGES.map(shopPage);

  test.each([
    ["/shop/ok", 200, null],
    ["/shop/error", 503, "shop-error"],
    ["/shop/missing", 404, "shop-not-found"],
  ] as const)(
    "a layout receives the same props when the page at %s succeeds or fails",
    async (href, status, expectedFallback) => {
      const result = await serverRenderAndHydrate(routes, href);

      expect(result.status).toBe(status);
      expect(result.recoverable).toEqual([]);
      expect(shopLayoutProps()).toEqual(SHOP_LAYOUT_PROPS);
      expect(fallback() ?? null).toBe(expectedFallback);

      await clientNavigate("/shop/error");
      expect(shopLayoutProps()).toEqual(SHOP_LAYOUT_PROPS);
      await clientNavigate("/shop/missing");
      expect(shopLayoutProps()).toEqual(SHOP_LAYOUT_PROPS);
      await clientNavigate("/shop/ok");
      expect(shopLayoutProps()).toEqual(SHOP_LAYOUT_PROPS);
      expect(document.querySelector("[data-page='shop']")?.textContent).toBe("Page title");
    }
  );

  test("a layout loader error skips that segment's error.tsx on the server and the client", async () => {
    const result = await serverRenderAndHydrate(routes, "/shop/broken");

    expect(result.status).toBe(503);
    expect(result.recoverable).toEqual([]);
    expect(fallback()).toBe("root-error");
    expect(document.querySelector("[data-layout='root']")).not.toBeNull();
    expect(shopLayoutProps()).toBeUndefined();

    await clientNavigate("/shop/ok");
    expect(fallback()).toBeUndefined();
    await clientNavigate("/shop/broken");
    expect(fallback()).toBe("root-error");
    expect(document.querySelector("[data-layout='root']")).not.toBeNull();
    expect(shopLayoutProps()).toBeUndefined();
  });

  test("a head() failure hydrates the page boundary inside the layouts", async () => {
    const definition = defineRoute()
      .config({ layout: shopDefinition, mode: "ssr" })
      .head(() => {
        throw new Error("head exploded");
      })
      .page(() => <p>never</p>);
    const route = toTestRoute("/shop/head", adaptDefinedPage(definition, shop), BOUNDARIES);

    const result = await serverRenderAndHydrate([route], "/shop/head");

    expect(result.status).toBe(500);
    expect(result.recoverable).toEqual([]);
    expect(fallback()).toBe("shop-error");
    expect(shopLayoutProps()).toEqual(SHOP_LAYOUT_PROPS);
  });

  test("a shell render failure hydrates the same error document the server sent", async () => {
    const definition = defineRoute()
      .config({ layout: rootDefinition, mode: "ssr" })
      .page(() => {
        throw new Error("render exploded");
      });
    const broken = toTestRoute("/broken", adaptDefinedPage(definition, root.route), [
      { depth: 0, error: RootError, path: "/pages" },
    ]);

    const result = await serverRenderAndHydrate([broken], "/broken");

    expect(result.status).toBe(500);
    expect(result.serverBody).toContain('data-fallback="root-error"');
    expect(result.recoverable).toEqual([]);
    expect(document.body.innerHTML).toBe(result.serverBody);
  });
});
