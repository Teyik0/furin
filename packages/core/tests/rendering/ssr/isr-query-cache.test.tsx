import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
import { __resetCacheState, revalidatePath } from "../../../src/server/cache/index.ts";
import { renderForPath } from "../../../src/server/render/ssr.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

const originalDevMode = IS_DEV;
const rootTerminal = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <body>{children}</body>
    </html>
  ));
const root = {
  path: "/root.tsx",
  route: adaptDefinedLayout(rootTerminal, undefined),
} satisfies RootLayout;

function resolveRoute(
  route: Parameters<typeof adaptDefinedPage>[0],
  path: string,
  pattern: string
): ResolvedRoute {
  const page = adaptDefinedPage(route, root.route);
  return {
    mode: page.mode ?? "ssr",
    page,
    path,
    pattern,
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
}

beforeAll((done) => {
  __setDevMode(false);
  __resetCacheState();
  done();
});

afterEach((done) => {
  __resetCacheState();
  done();
});

afterAll((done) => {
  __setDevMode(originalDevMode);
  done();
});

test("ISR cache keys include the query string and path invalidation clears every variant", async () => {
  let loaderCalls = 0;
  const route = defineRoute()
    .config({
      layout: rootTerminal,
      mode: "isr",
      query: t.Object({ tenant: t.Optional(t.String()) }),
      revalidate: 60,
    })
    .loader(({ query }) => {
      loaderCalls += 1;
      return { tenant: query.tenant ?? "" };
    })
    .page(({ data }) => <main data-tenant={data.tenant}>{data.tenant}</main>);
  const resolved = resolveRoute(route, "/search.tsx", "/search");
  const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

  const alpha = await app
    .handle(new Request("http://localhost/search?tenant=alpha"))
    .then((response) => response.text());
  const beta = await app
    .handle(new Request("http://localhost/search?tenant=beta"))
    .then((response) => response.text());

  expect(alpha).toContain("alpha");
  expect(beta).toContain("beta");
  expect(loaderCalls).toBe(2);

  expect(revalidatePath("/search", "page")).toBe(true);

  await app.handle(new Request("http://localhost/search?tenant=alpha"));
  await app.handle(new Request("http://localhost/search?tenant=beta"));
  expect(loaderCalls).toBe(4);
});

test("ISR cached loaders reject request-specific context", async () => {
  const route = defineRoute()
    .config({
      layout: rootTerminal,
      mode: "isr",
      query: t.Object({ tenant: t.Optional(t.String()) }),
      revalidate: 60,
    })
    .loader(({ cookie, query }) => ({
      session: cookie.session,
      tenant: query.tenant ?? "",
    }))
    .page(({ data }) => <main>{data.tenant}</main>);
  const resolved = resolveRoute(route, "/private.tsx", "/private");
  const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

  const alice = await app.handle(
    new Request("http://localhost/private?tenant=alpha", { headers: { cookie: "session=alice" } })
  );
  const bob = await app.handle(
    new Request("http://localhost/private?tenant=alpha", { headers: { cookie: "session=bob" } })
  );

  expect(alice.status).toBe(500);
  expect(bob.status).toBe(500);
  expect(await alice.text()).not.toContain("alice");
  expect(await bob.text()).not.toContain("bob");
});

test("synthetic ISR renders preserve repeated query values for loaders", async () => {
  let observedQuery: unknown;
  const route = defineRoute()
    .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
    .loader(({ query }) => {
      observedQuery = query;
      return {};
    })
    .page(() => <main>search</main>);
  const resolved = resolveRoute(route, "/search.tsx", "/search");

  await renderForPath(
    resolved,
    {},
    root,
    "http://localhost",
    "isr",
    undefined,
    undefined,
    "?tag=a&tag=b"
  );

  expect(observedQuery).toEqual({ tag: ["a", "b"] });
});

test("synthetic ISR renders preserve __proto__ query values for loaders", async () => {
  let observedQuery: unknown;
  const route = defineRoute()
    .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
    .loader(({ query }) => {
      observedQuery = query;
      return {};
    })
    .page(() => <main>search</main>);
  const resolved = resolveRoute(route, "/search.tsx", "/search");

  await renderForPath(
    resolved,
    {},
    root,
    "http://localhost",
    "isr",
    undefined,
    undefined,
    "?__proto__=from-input"
  );

  expect(Object.hasOwn(observedQuery as object, "__proto__")).toBe(true);
  expect(Reflect.get(observedQuery as object, "__proto__")).toBe("from-input");
});
