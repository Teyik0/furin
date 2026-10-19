import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Suspense } from "react";
import { QueryStore } from "../../../src/client/query-store.ts";
import { createClient } from "../../../src/client.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { type RenderResult, renderToHTML } from "../../../src/server/render/buffered-render.ts";
import { renderSSR } from "../../../src/server/render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { Await } from "../../../src/shared/await.tsx";
import { defer } from "../../../src/shared/defer.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { type NotFoundProps, notFound } from "../../../src/shared/not-found.ts";
import { findRouteFailure } from "../../../src/shared/route-matches.ts";
import type { QuerySeed } from "../../../src/shared/sync-query.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { mountProductionApp } from "../../support/production-app.ts";

let previousDevMode: boolean;
const DATA_SCRIPT = /<script[^>]*id="__FURIN_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const ROUTE_TEMPLATE = /<template[^>]*id="__FURIN_ROUTE_FRAMES__"[^>]*>([\s\S]*?)<\/template>/;
beforeEach(() => {
  previousDevMode = IS_DEV;
  __setDevMode(false);
});
afterEach(() => {
  __resetCompileContext();
  __setDevMode(previousDevMode);
});

function parseData(payload: string) {
  const { body } = new Response(payload);
  if (!body) {
    throw new Error("Transport response body missing");
  }
  return parseDeferredNdjson(body, undefined);
}

async function documentData(html: string): Promise<{ [key: string]: unknown }> {
  const json = html.match(DATA_SCRIPT)?.[1];
  if (json !== undefined) {
    return JSON.parse(json);
  }
  const template = html.match(ROUTE_TEMPLATE)?.[1];
  if (template === undefined) {
    throw new Error("Document hydration payload missing");
  }
  return (await parseData(template.replaceAll("&lt;", "<").replaceAll("&amp;", "&"))).syncData;
}

test.each(["deferred", "request"] as const)(
  "a 404 streams successful parent %s data",
  async (kind) => {
    const base = defineRootRoute().config({ mode: "ssr" });
    const definition = (
      kind === "deferred"
        ? base.loader(() => defer({ greeting: Promise.resolve("Welcome home") }))
        : base.requestLoader(() => ({ greeting: "Welcome home" }))
    ).layout(({ children, greeting }) => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          <Suspense fallback={<p>Loading greeting</p>}>
            <Await resolve={greeting}>{(value) => <h1>{value}</h1>}</Await>
          </Suspense>
          {children}
          <Scripts />
        </body>
      </html>
    ));
    const root = { path: "/root.tsx", route: adaptDefinedLayout(definition, undefined) };
    const pageDefinition = defineRoute()
      .config({ layout: definition, mode: "ssr" })
      .loader(() => notFound(undefined))
      .page(() => <p>Resource</p>);
    const page = adaptDefinedPage(pageDefinition, root.route);
    const route = {
      mode: "ssr" as const,
      page,
      path: "/missing.tsx",
      pattern: "/missing",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
      ...(kind === "request"
        ? { requestKeys: ["greeting"], requestKeysByLoader: [["greeting"], []] }
        : {}),
    };
    const response = await new Elysia()
      .get("/missing", (context) => renderSSR(route, context, root, undefined))
      .handle(new Request("http://localhost/missing"));
    expect(response.status).toBe(404);
    expect(await response.text()).toContain("Welcome home");
    const { app } = await mountProductionApp({
      buildId: "test",
      pages: [
        {
          pattern: "/missing",
          requestKeys: kind === "request" ? ["greeting"] : undefined,
          route: pageDefinition,
        },
      ],
      root: definition,
    });
    const navigation = await app.handle(new Request("http://localhost/missing?_furin=data"));
    const parsed = await parseData(await navigation.text());
    expect(await parsed.deferredPromises.greeting).toBe("Welcome home");
  }
);

test.each([404, 503])(
  "failed pages preserve each successful layout's own loader scope (%s)",
  async (status) => {
    const rootDefinition = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => ({ dashboard: { settings: { theme: "forest" } } }))
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
      .config({ layout: rootDefinition, mode: "ssr" })
      .loader(async ({ dashboard }) => ({
        dashboard: { ...(await dashboard), settings: { theme: "ocean" } },
        section: "Library",
      }))
      .layout(({ children, dashboard, section }) => (
        <section data-theme={dashboard.settings.theme}>
          <h1>{section}</h1>
          {children}
        </section>
      ));
    const definition = defineRoute()
      .config({ layout: nestedDefinition, mode: "ssr" })
      .loader(async ({ dashboard }) => {
        expect((await dashboard).settings.theme).toBe("ocean");
        if (status === 404) {
          notFound({ message: "Missing resource", data: { slug: "gone" } });
        }
        throw new Response("Resource unavailable", { status });
      })
      .page(() => <p>Resource</p>);
    const { app } = await mountProductionApp({
      buildId: "test",
      pages: [
        {
          // Declared beside the nested layout, so they render inside that layout.
          layout: {
            error: () => <p>Library unavailable</p>,
            notFound: ({ error }: NotFoundProps) => <p>Library: {error.message}</p>,
            route: nestedDefinition,
            segment: "library",
          },
          pattern: "/missing",
          route: definition,
        },
      ],
      root: rootDefinition,
    });
    const response = await app.handle(new Request("http://localhost/missing"));

    expect(response.status).toBe(status);
    const html = await response.text();
    expect(html).toContain('<body data-theme="forest">');
    expect(html).toContain('<section data-theme="ocean">');
    expect(html).toContain("Library");
    expect(html).toContain(
      status === 404 ? "Library: <!-- -->Missing resource" : "Library unavailable"
    );
    const navigation = await app.handle(new Request("http://localhost/missing?_furin=data"));
    const parsed = await parseData(await navigation.text());
    expect(parsed.syncData.dashboard).toEqual({ settings: { theme: "ocean" } });
    expect(parsed.syncData.section).toBe("Library");
    expect(parsed.syncData.__furinMatches).toEqual((await documentData(html)).__furinMatches);
  }
);

test("buffered not-found documents carry the same status and payload as navigation", async () => {
  const layout = defineRootRoute()
    .config({ mode: "ssg" })
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
  const definition = defineRoute()
    .config({ layout, mode: "ssg" })
    .loader(() => notFound({ message: "Missing", data: { slug: "gone" } }))
    .page(() => <main>Page</main>);
  const root = { path: "/root.tsx", route: adaptDefinedLayout(layout, undefined) };
  const page = adaptDefinedPage(definition, root.route);
  const route = {
    mode: "ssg" as const,
    page,
    path: "/missing.tsx",
    pattern: "/missing",
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
  let result: RenderResult | undefined;
  const response = await new Elysia()
    .get("/missing", async (context) => {
      result = await renderToHTML(route, context, root);
      return new Response(result.html, { status: result.status });
    })
    .handle(new Request("http://localhost/missing"));
  expect(response.status).toBe(404);
  expect(result).toBeDefined();
  if (result === undefined) {
    throw new Error("Buffered render result missing");
  }
  const parsed = await parseData(result.ndjson);
  const expected = {
    error: { message: "Missing", data: { slug: "gone" } },
    index: 2,
    status: "notFound" as const,
  };
  expect(findRouteFailure(parsed.syncData)).toEqual(expected);
  expect(findRouteFailure(await documentData(result.html))).toEqual(expected);
});

test("SSR hydration preserves rich loader values and escapes document delimiters", async () => {
  const layout = defineRootRoute()
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
  const cycle: { self?: object } = {};
  cycle.self = cycle;
  const definition = defineRoute()
    .config({ layout, mode: "ssr" })
    .loader(() => ({
      date: new Date("2026-01-01"),
      big: 123n,
      map: new Map([["key", "value"]]),
      cycle,
      text: "</template><script>alert(1)</script>",
    }))
    .page(({ date, big }) => (
      <main>
        {date.getUTCFullYear()} {String(big)}
      </main>
    ));
  const { app } = await mountProductionApp({
    buildId: "test",
    pages: [{ pattern: "/rich", route: definition }],
    root: layout,
  });
  const response = await app.handle(new Request("http://localhost/rich"));
  expect(response.status).toBe(200);
  const html = await response.text();
  expect(html).toContain("2026");
  expect(html).not.toContain("<script>alert(1)</script>");
  const syncData = await documentData(html);
  expect(syncData.date).toBeInstanceOf(Date);
  expect(syncData.big).toBe(123n);
  expect(syncData.map).toEqual(new Map([["key", "value"]]));
  expect((syncData.cycle as { self: object }).self).toBe(syncData.cycle as object);
  expect(syncData.text).toBe("</template><script>alert(1)</script>");
});

test("SSR document framing preserves raw script and comment closing-tag literals after Scripts", async () => {
  const rawScript = 'window.marker="</html>";';
  const rawComment = "<!--literal </body></html>-->";
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Scripts />
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Trusted fixture probes raw script framing. */}
          <script dangerouslySetInnerHTML={{ __html: rawScript }} />
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: Trusted fixture probes raw comment framing. */}
          <span dangerouslySetInnerHTML={{ __html: rawComment }} />
        </body>
      </html>
    ));
  const definition = defineRoute()
    .config({ layout, mode: "ssr" })
    .loader(() => ({ rich: new Date("2026-01-01") }))
    .page(() => <main>Ready</main>);
  const { app } = await mountProductionApp({
    buildId: "test",
    pages: [{ pattern: "/raw", route: definition }],
    root: layout,
  });
  const response = await app.handle(new Request("http://localhost/raw"));
  const html = await response.text();
  expect(html).toContain(rawScript);
  expect(html).toContain(rawComment);
  expect(html.endsWith("</span></body></html>")).toBe(true);
});

test("SSR query seeds preserve opaque variants without exposing credentials or aliasing defaults", async () => {
  const api = createClient(
    new Elysia().get("/person", ({ set }) => {
      set.headers["x-furin-query"] = JSON.stringify({ id: "person", scope: {}, session: "alice" });
      return { name: "Alice" };
    })
  );
  const layout = defineRootRoute()
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
  const definition = defineRoute()
    .config({ layout, mode: "ssr" })
    .loader(async () => ({
      person: (
        await api.person.get({
          headers: { authorization: "Bearer confidential-test-token" },
        })
      ).data,
    }))
    .page(({ person }) => <main>{person?.name}</main>);
  const { app } = await mountProductionApp({
    buildId: "test",
    pages: [{ pattern: "/person", route: definition }],
    root: layout,
  });
  const response = await app.handle(new Request("http://localhost/person"));
  const html = await response.text();
  expect(html).toContain("Alice");
  expect(html).not.toContain("confidential-test-token");
  const data = await documentData(html);
  expect(data.__furinQueries).toMatchObject([
    {
      identity: { id: "person", session: "alice" },
      data: { name: "Alice" },
    },
  ]);
  const seeds = data.__furinQueries as QuerySeed[];
  // Opaque identities preserve private bindings; credentials never enter these URLs.
  expect(new URL(seeds[0]?.url as string).hash).toStartWith("#furin-query:");
  const browserQueries = new QueryStore(undefined);
  browserQueries.hydrate(seeds, "https://browser.example");
  expect(browserQueries.snapshot("https://browser.example/person").data).toBeUndefined();
  expect(browserQueries.dehydrate()[0]?.url).not.toContain("confidential-test-token");
});
