import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { collectRouteTags } from "../../../src/server/router/discovery.ts";
import { createDataEndpoint } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
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
    routeChain,
    segmentBoundaries: [],
    tags: collectRouteTags(routeChain, page),
  };
}

function fetchData(route: ResolvedRoute): Promise<Response> {
  const app = new Elysia().use(createDataEndpoint([route]));
  return app.handle(
    new Request(`http://localhost/_furin/data?path=${encodeURIComponent(route.pattern)}`)
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
      "public, max-age=0, must-revalidate, s-maxage=75, stale-while-revalidate=75"
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
