import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { t } from "elysia";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCacheState, revalidatePath } from "../../../src/server/cache/index.ts";
import { isrCache, waitForPendingISRRevalidations } from "../../../src/server/cache/isr.ts";
import { withInstance } from "../../../src/server/instance.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { renderForPath } from "../../../src/server/render/buffered-render.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";
import { mountProductionApp } from "../../support/production-app.ts";

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

function mountPage(
  pattern: string,
  route: Parameters<typeof mountProductionApp>[0]["pages"][number]["route"],
  buildId: string
) {
  return mountProductionApp({ buildId, pages: [{ pattern, route }], root: rootTerminal });
}

beforeAll((done) => {
  __setDevMode(false);
  __resetCacheState();
  done();
});

afterEach((done) => {
  __resetCacheState();
  __resetCompileContext();
  done();
});

afterAll((done) => {
  __setDevMode(originalDevMode);
  done();
});

test("ISR cache keys include the query string and path invalidation clears every variant", async () => {
  let loaderCalls = 0;
  const route = defineRoute("/")
    .config({
      mode: "isr",
      query: t.Object({ tenant: t.Optional(t.String()) }),
      revalidate: 60,
    })
    .loader(({ query }) => {
      loaderCalls += 1;
      return { tenant: query.tenant ?? "" };
    })
    .page(({ tenant }) => <main data-tenant={tenant}>{tenant}</main>);
  const { app } = await mountPage("/search", route, "build-1");

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

test("ISR cache keys ignore undeclared query params and canonicalise declared ones", async () => {
  let loaderCalls = 0;
  const route = defineRoute("/")
    .config({
      mode: "isr",
      query: t.Object({ sort: t.Optional(t.String()), tenant: t.Optional(t.String()) }),
      revalidate: 60,
    })
    .loader(({ query }) => {
      loaderCalls += 1;
      return { tenant: query.tenant ?? "" };
    })
    .page(({ tenant }) => <main data-tenant={tenant}>{tenant}</main>);
  const { app, instance } = await mountPage("/search", route, "build-1");

  for (const search of [
    "?tenant=alpha&sort=new",
    "?sort=new&tenant=alpha&junk=1",
    "?junk=2&tenant=alpha&sort=new",
    "?tenant=alpha&sort=new&utm_source=x",
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
    const response = await app.handle(new Request(`http://localhost/search${search}`));
    expect(await response.text()).toContain("alpha");
  }

  expect(loaderCalls).toBe(1);
  expect(withInstance(instance, () => [...isrCache.keys()])).toEqual([
    "/search?sort=new&tenant=alpha",
  ]);
});

test("ISR cache keys hold declared query values as the schema decodes them", async () => {
  let loaderCalls = 0;
  const route = defineRoute("/")
    .config({
      mode: "isr",
      query: t.Object({
        page: t.Number({ default: 1 }),
        tags: t.Optional(t.Array(t.String())),
      }),
      revalidate: 60,
    })
    .loader(({ query }) => {
      loaderCalls += 1;
      return { page: query.page };
    })
    .page(({ page }) => <main data-page={page}>{page}</main>);
  const { app, instance } = await mountPage("/search", route, "build-1");

  for (const search of ["?page=02", "?page=2", "?page=2.0&junk=1"]) {
    // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
    const response = await app.handle(new Request(`http://localhost/search${search}`));
    expect(await response.text()).toContain('data-page="2"');
  }
  for (const search of ["", "?page=1", "?page=01"]) {
    // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
    await app.handle(new Request(`http://localhost/search${search}`));
  }
  for (const search of ["?tags=b&tags=a", "?page=1&tags=b&tags=a"]) {
    // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
    await app.handle(new Request(`http://localhost/search${search}`));
  }
  const invalid = await app.handle(new Request("http://localhost/search?page=abc"));

  expect(invalid.status).toBeGreaterThanOrEqual(400);
  expect(invalid.headers.get("cache-control") ?? "").not.toContain("public");
  expect(loaderCalls).toBe(3);
  expect(withInstance(instance, () => [...isrCache.keys()])).toEqual([
    "/search?page=2",
    "/search",
    "/search?tags=b&tags=a",
  ]);
});

test("ISR routes without a query schema key on the path and hide the raw query from loaders", async () => {
  const observed: unknown[] = [];
  const route = defineRoute("/")
    .config({ mode: "isr", revalidate: 0 })
    .loader(({ query }) => {
      observed.push({ ...query });
      return {};
    })
    .page(() => <main>static</main>);
  const { app, instance } = await mountPage("/plain", route, "build-1");

  const first = await app.handle(new Request("http://localhost/plain?x=attacker"));
  expect(await first.text()).not.toContain("attacker");
  await app.handle(new Request("http://localhost/plain?x=2"));
  await withInstance(instance, waitForPendingISRRevalidations);

  expect(withInstance(instance, () => [...isrCache.keys()])).toEqual(["/plain"]);
  expect(observed).toEqual([{}, {}]);
});

test("ISR cached loaders reject request-specific context", async () => {
  const route = defineRoute("/")
    .config({
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
  const { app } = await mountPage("/private", route, "build-1");

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
  const route = defineRoute("/")
    .config({ mode: "isr", revalidate: 60 })
    .loader(() => {
      loaderCalls += 1;
      throw error;
    })
    .page(() => <main>content</main>);
  const { app } = await mountProductionApp({
    buildId: "build-1",
    pages: [{ pattern: "/content", route }],
    root: rootTerminal,
    rootError: ({ error: boundaryError }) => (
      <main>{`${boundaryError.status}: ${boundaryError.message}`}</main>
    ),
  });

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
  const route = defineRoute("/observed-query")
    .config({ mode: "isr", revalidate: 60 })
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
  const terminal = defineRoute("/terminal")
    .config({
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
  const { app, instance } = await mountPage("/typed", terminal, "build");

  await app.handle(new Request("http://localhost/typed?count=2"));
  await app.handle(new Request("http://localhost/typed?count=2"));
  await withInstance(instance, waitForPendingISRRevalidations);
  await app.handle(new Request("http://localhost/typed"));
  await app.handle(new Request("http://localhost/typed"));
  await withInstance(instance, waitForPendingISRRevalidations);

  expect(values).toEqual([3, 3, 2, 2]);
});

test("synthetic ISR renders preserve __proto__ query values for loaders", async () => {
  let observedQuery: unknown;
  const route = defineRoute("/observed-query")
    .config({ mode: "isr", revalidate: 60 })
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
  const route = defineRoute("/")
    .config({ mode: "isr", revalidate: 60 })
    .loader(() => ({}))
    .page(() => <p>invalid ISR content</p>);
  const { app } = await mountProductionApp({
    buildId: "build-1",
    pages: [{ pattern: "/isr", route }],
    root: invalidRootTerminal,
  });

  const first = await app.handle(new Request("http://localhost/isr"));
  const second = await app.handle(new Request("http://localhost/isr"));
  const html = await second.text();

  expect(first.status).toBe(500);
  expect(second.status).toBe(500);
  expect(html).toContain("Something went wrong");
  expect(html).not.toContain("invalid ISR content");
});
