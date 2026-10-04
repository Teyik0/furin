import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCacheState, revalidatePath } from "../../../src/server/cache/index.ts";
import { waitForPendingISRRevalidations } from "../../../src/server/cache/isr.ts";
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
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ));
const root = {
  path: "/root.tsx",
  route: adaptDefinedLayout(rootTerminal, undefined),
} satisfies RootLayout;

function resolveRoute(
  route: Parameters<typeof adaptDefinedPage>[0],
  path: string,
  pattern: string,
  routeRoot: RootLayout
): ResolvedRoute {
  const page = adaptDefinedPage(route, routeRoot.route);
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
    .page(({ tenant }) => <main data-tenant={tenant}>{tenant}</main>);
  const resolved = resolveRoute(route, "/search.tsx", "/search", root);
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

  expect(await revalidatePath("/search", "page")).toBe(true);

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
    .loader((context) => ({
      // @ts-expect-error cached loaders cannot read cookies; verify the runtime guard too.
      session: context.cookie.session,
      tenant: context.query.tenant ?? "",
    }))
    .page(({ tenant }) => <main>{tenant}</main>);
  const resolved = resolveRoute(route, "/private.tsx", "/private", root);
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

test("a thrown Eden problem reaches the error boundary without entering the ISR cache", async () => {
  let loaderCalls = 0;
  const error = Object.assign(new Error("Eden response"), {
    status: 404,
    value: {
      detail: "Content not found",
      status: 404,
      title: "Not Found",
      type: "about:blank",
    },
  });
  const route = defineRoute()
    .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
    .loader(() => {
      loaderCalls += 1;
      throw error;
    })
    .page(() => <main>content</main>);
  const rootWithError = {
    ...root,
    error: ({ error: boundaryError }) => (
      <main>{`${boundaryError.status}: ${boundaryError.message}`}</main>
    ),
  } satisfies RootLayout;
  const resolved = resolveRoute(route, "/content.tsx", "/content", rootWithError);
  const app = new Elysia().use(createRoutePlugin(resolved, rootWithError, "build-1"));

  const first = await app.handle(new Request("http://localhost/content"));
  const second = await app.handle(new Request("http://localhost/content"));

  expect(first.status).toBe(404);
  expect(first.headers.get("cache-control")).toBe("no-store");
  expect(await first.text()).toContain("404: Content not found");
  expect(second.status).toBe(404);
  expect(loaderCalls).toBe(2);
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
  const resolved = resolveRoute(route, "/search.tsx", "/search", root);

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

test("ISR regeneration preserves query coercion and schema defaults", async () => {
  const values: number[] = [];
  const terminal = defineRoute()
    .config({
      layout: rootTerminal,
      mode: "isr",
      query: t.Object({ count: t.Number({ default: 1 }) }),
      revalidate: 0,
    })
    .loader(({ query }) => {
      const value = query.count + 1;
      values.push(value);
      return { value };
    })
    .page(({ value }) => <main>{value}</main>);
  const route = resolveRoute(terminal, "/typed.tsx", "/typed", root);
  const app = new Elysia().use(createRoutePlugin(route, root, "build"));

  await app.handle(new Request("http://localhost/typed?count=2"));
  await app.handle(new Request("http://localhost/typed?count=2"));
  await waitForPendingISRRevalidations();
  await app.handle(new Request("http://localhost/typed"));
  await app.handle(new Request("http://localhost/typed"));
  await waitForPendingISRRevalidations();

  expect(values).toEqual([3, 3, 2, 2]);
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
  const resolved = resolveRoute(route, "/search.tsx", "/search", root);

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

test("an invalid ISR root document is not cached as a successful render", async () => {
  const invalidRootTerminal = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => <main data-invalid-root="">{children}</main>);
  const invalidRoot = {
    path: "/root.tsx",
    route: adaptDefinedLayout(invalidRootTerminal, undefined),
  } satisfies RootLayout;
  const route = defineRoute()
    .config({ layout: invalidRootTerminal, mode: "isr", revalidate: 60 })
    .loader(() => ({}))
    .page(() => <p>invalid ISR content</p>);
  const resolved = resolveRoute(route, "/isr.tsx", "/isr", invalidRoot);
  const app = new Elysia().use(createRoutePlugin(resolved, invalidRoot, "build-1"));

  const first = await app.handle(new Request("http://localhost/isr"));
  const second = await app.handle(new Request("http://localhost/isr"));
  const html = await second.text();

  expect(first.status).toBe(500);
  expect(second.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("invalid ISR content");
});
