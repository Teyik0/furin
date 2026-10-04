import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { collectRouteTags } from "../../../src/server/router/discovery.ts";
import { createDataEndpoint } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const originalDevMode = IS_DEV;
const rootTerminal = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => <html lang="en">{children}</html>);
const root = {
  path: "/root.tsx",
  route: adaptDefinedLayout(rootTerminal, undefined),
} satisfies RootLayout;

function resolveRoute(
  route: Parameters<typeof adaptDefinedPage>[0],
  pattern: string
): ResolvedRoute {
  const page = adaptDefinedPage(route, root.route);
  const routeChain = collectRouteChainFromRoute(page._route);
  return {
    mode: page.mode ?? "ssr",
    page,
    path: `${pattern}.tsx`,
    pattern,
    requestKeys: pattern === "/account" ? ["user"] : [],
    routeChain,
    segmentBoundaries: [],
    tags: collectRouteTags(routeChain, page),
  };
}

function fetchData(route: ResolvedRoute): Promise<Response> {
  const app = new Elysia().use(createDataEndpoint([route]));
  return app.handle(
    new Request(`http://localhost/_furin/data?path=${encodeURIComponent(route.pattern)}`, {
      headers: { cookie: "session=alice" },
    })
  );
}

beforeAll(async () => {
  __setDevMode(false);
  await Promise.resolve();
});

afterAll(async () => {
  __setDevMode(originalDevMode);
  await Promise.resolve();
});

describe("navigation data cache contract", () => {
  test("loader redirects preserve external destinations and response cookies", async () => {
    const cookie = "session=; Max-Age=0; Path=/";
    const route = resolveRoute(
      defineRoute()
        .config({ layout: rootTerminal, mode: "ssr" })
        .loader(() => {
          throw new Response(null, {
            headers: {
              location: "https://auth.example/authorize?client=furin",
              "set-cookie": cookie,
            },
            status: 302,
          });
        })
        .page(() => null),
      "/logout"
    );

    const response = await fetchData(route);
    if (response.body === null) {
      throw new Error("Missing navigation payload");
    }
    const payload = await parseDeferredNdjson(response.body, undefined);
    expect(payload.syncData.__furinRedirect).toBe("https://auth.example/authorize?client=furin");
    expect(response.headers.get("set-cookie")).toBe(cookie);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  test("caches SSG payloads for one year under the page cache tag", async () => {
    const route = resolveRoute(
      defineRoute()
        .config({ layout: rootTerminal, mode: "ssg" })
        .loader(() => ({ value: "static" }))
        .page(() => null),
      "/catalog"
    );

    const response = await fetchData(route);

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate, s-maxage=31536000"
    );
    expect(response.headers.get("cache-tag")).toBe("/catalog");
  });

  test("caches ISR payloads with the route revalidation window", async () => {
    const route = resolveRoute(
      defineRoute()
        .config({ layout: rootTerminal, mode: "isr", revalidate: 75 })
        .loader(() => ({ value: "fresh" }))
        .page(() => null),
      "/news"
    );

    const response = await fetchData(route);

    expect(response.headers.get("cache-control")).toBe(
      "public, max-age=0, s-maxage=75, stale-while-revalidate=75"
    );
    expect(response.headers.get("cache-tag")).toBe("/news");
  });

  test("never caches request-specific ISR payloads", async () => {
    const route = resolveRoute(
      defineRoute()
        .config({ layout: rootTerminal, mode: "isr", revalidate: 75 })
        .requestLoader(({ cookies }) => ({ user: cookies.get("session") }))
        .loader(() => ({ value: "public" }))
        .page(() => null),
      "/account"
    );

    const response = await fetchData(route);

    expect(response.status).toBe(200);
    if (response.body === null) {
      throw new Error("Missing navigation payload");
    }
    const payload = await parseDeferredNdjson(response.body, undefined);
    expect(payload.syncData.value).toBe("public");
    expect(await payload.deferredPromises.user).toBe("alice");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cache-tag")).toBeNull();
  });

  test("never caches failed ISR payloads", async () => {
    const route = resolveRoute(
      defineRoute()
        .config({ layout: rootTerminal, mode: "isr", revalidate: 75 })
        .loader(() => {
          throw new Error("loader failed");
        })
        .page(() => null),
      "/broken"
    );

    const response = await fetchData(route);

    expect(response.status).toBe(500);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("cache-tag")).toBeNull();
  });
});
