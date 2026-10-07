import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createClient } from "../../../src/client.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { type RenderResult, renderToHTML } from "../../../src/server/render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { notFound } from "../../../src/shared/not-found.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

let previousDevMode: boolean;
const DATA_SCRIPT = /<script[^>]*id="__FURIN_DATA__"[^>]*>([\s\S]*?)<\/script>/;
const ROUTE_TEMPLATE = /<template[^>]*id="__FURIN_ROUTE_FRAMES__"[^>]*>([\s\S]*?)<\/template>/;
beforeEach(() => {
  previousDevMode = IS_DEV;
  __setDevMode(false);
});
afterEach(() => __setDevMode(previousDevMode));

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
  expect(parsed.syncData.__furinStatus).toBe(404);
  expect(parsed.syncData.__furinNotFound).toEqual({ message: "Missing", data: { slug: "gone" } });
  const data = await documentData(result.html);
  expect(data.__furinStatus).toBe(404);
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
  const root = { path: "/root.tsx", route: adaptDefinedLayout(layout, undefined) };
  const page = adaptDefinedPage(definition, root.route);
  const route = {
    mode: "ssr" as const,
    page,
    path: "/rich.tsx",
    pattern: "/rich",
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
  const response = await new Elysia()
    .use(createRoutePlugin(route, root, "test"))
    .handle(new Request("http://localhost/rich"));
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

test("SSR query seeds reach HTML without serializing credentials or cache keys", async () => {
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
  const root = { path: "/root.tsx", route: adaptDefinedLayout(layout, undefined) };
  const page = adaptDefinedPage(definition, root.route);
  const route = {
    mode: "ssr" as const,
    page,
    path: "/person.tsx",
    pattern: "/person",
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
  const response = await new Elysia()
    .use(createRoutePlugin(route, root, "test"))
    .handle(new Request("http://localhost/person"));
  const html = await response.text();
  expect(html).toContain("Alice");
  expect(html).not.toContain("confidential-test-token");
  expect(html).not.toContain("furin-query:");
  const data = await documentData(html);
  expect(data.__furinQueries).toMatchObject([
    {
      identity: { id: "person", session: "alice" },
      data: { name: "Alice" },
    },
  ]);
});
