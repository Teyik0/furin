import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { Suspense, use } from "react";
import { createClient, defer } from "../../../src/client.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { revalidateTag } from "../../../src/server/auto-invalidate";
import { getAutoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
import { revalidatePathForInstance } from "../../../src/server/cache/invalidation.ts";
import {
  createMemoryPageCache,
  type PageCacheAdapter,
  type PageCacheIdentity,
} from "../../../src/server/cache/page-cache.ts";
import {
  resetPageCacheAdapter,
  setPageCacheAdapter,
} from "../../../src/server/cache/page-cache-state.ts";
import {
  resetRuntimeCacheProvider,
  setRuntimeCacheProvider,
} from "../../../src/server/cache/runtime-cache.ts";
import { markExternalPrerenderRequest } from "../../../src/server/external-prerender.ts";
import {
  __clearInstanceRegistry,
  createInstance,
  currentInstance,
  registerInstance,
  withInstance,
} from "../../../src/server/instance.ts";
import { clearMixedPublicCache } from "../../../src/server/render/mixed-cache.ts";
import { clearPprRouteCache, invalidatePprRoute } from "../../../src/server/render/ppr-route";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { collectRouteTags } from "../../../src/server/router/discovery.ts";
import { createDataEndpoint, createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { type QuerySeed, queryTag } from "../../../src/shared/sync-query.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

afterEach(async () => {
  clearPprRouteCache();
  clearMixedPublicCache();
  resetRuntimeCacheProvider();
  await Promise.resolve();
});
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

function resolveRoute(route: Parameters<typeof adaptDefinedPage>[0]): ResolvedRoute {
  const page = adaptDefinedPage(route, root.route);
  const routeChain = collectRouteChainFromRoute(page._route);
  return {
    mode: page.mode ?? "ssr",
    page,
    path: "/account.tsx",
    pattern: "/account",
    requestKeys: routeChain.some((entry) => entry.requestLoader) ? ["user"] : [],
    routeChain,
    segmentBoundaries: [],
    tags: collectRouteTags(routeChain, page),
  };
}

beforeAll(async () => {
  __setDevMode(false);
  await Promise.resolve();
});
afterAll(async () => {
  __setDevMode(originalDevMode);
  await Promise.resolve();
});

test("SSR deferred responses stay private when a loader sets Cache-Control", async () => {
  const resolved = resolveRoute(
    defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .loader(({ request, set }) => {
        set.headers["Cache-Control"] = "public, s-maxage=60";
        return defer({
          title: "Account",
          user: Promise.resolve(request.headers.get("cookie")?.replace("session=", "")),
        });
      })
      .page(({ user }) => (
        <Suspense fallback="Loading">
          <User data={user} />
        </Suspense>
      ))
  );
  function User({ data }: { data: Promise<unknown> }) {
    return <strong>{String(use(data))}</strong>;
  }
  const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));
  const response = await app.handle(
    new Request("http://localhost/account", { headers: { cookie: "session=Alice" } })
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cache-control")).not.toContain("public");
  expect(await response.text()).toContain("Alice");
});

test("SSR exposes deferred fields as individual promises", async () => {
  let optionalWasAbsent = false;
  const resolved = resolveRoute(
    defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .loader(() => defer({ title: "Account", user: Promise.resolve("Alice") }))
      .page((props) => {
        optionalWasAbsent = (props as typeof props & { optional?: unknown }).optional === undefined;
        return (
          <main>
            <h1>{props.title}</h1>
            <Suspense fallback="Loading">
              <PrivateUser user={props.user} />
            </Suspense>
          </main>
        );
      })
  );
  function PrivateUser({ user }: { user: Promise<string> }) {
    return <strong>{use(user)}</strong>;
  }

  const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));
  const response = await app.handle(new Request("http://localhost/account"));

  expect(response.status).toBe(200);
  expect(await response.text()).toContain("<strong>Alice</strong>");
  expect(optionalWasAbsent).toBe(true);
});

describe.serial("partial prerendering", () => {
  for (const failure of ["unavailable", "invalid-json", "invalid-payload"]) {
    test(`serves PPR when the deployment cache is ${failure}`, async () => {
      setRuntimeCacheProvider({
        getCache() {
          return {
            delete: () => Promise.resolve(),
            expireTag: () => Promise.resolve(),
            get: () =>
              failure === "unavailable"
                ? Promise.reject(new Error("Cache unavailable"))
                : Promise.resolve(failure === "invalid-json" ? "{" : '{"ndjson":5,"headers":null}'),
            set: () => Promise.reject(new Error("Cache write unavailable")),
          };
        },
      });
      const resolved = resolveRoute(
        defineRoute()
          .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
          .requestLoader(() => ({ user: "alice" }))
          .loader(() => ({ catalog: "Fresh catalog" }))
          .page(({ catalog }) => <main>{catalog}</main>)
      );
      const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));
      const response = await app.handle(new Request("http://localhost/account"));
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("Fresh catalog");
    });
  }

  test("shares only serialized public data through the deployment provider", async () => {
    const values = new Map<string, unknown>();
    const writes: { key: string; tags?: string[]; ttl?: number }[] = [];
    setRuntimeCacheProvider({
      getCache() {
        return {
          delete: (key) => {
            values.delete(key);
            return Promise.resolve();
          },
          expireTag: () => {
            values.clear();
            return Promise.resolve();
          },
          get: (key) => Promise.resolve(values.get(key) ?? null),
          set: (key, value, options) => {
            // Model the provider's JSON wire format, rather than an in-memory clone.
            // react-doctor-disable-next-line react-doctor/no-json-parse-stringify-clone
            values.set(key, JSON.parse(JSON.stringify(value)));
            writes.push({ key, tags: options?.tags, ttl: options?.ttl });
            return Promise.resolve();
          },
        };
      },
    });
    let publicCalls = 0;
    let privateCalls = 0;
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => {
        privateCalls += 1;
        return { user: `private-${privateCalls}` };
      })
      .loader(() => {
        publicCalls += 1;
        return { catalog: publicCalls, date: new Date("2026-01-01") };
      });
    function User({ data }: { data: Promise<string> }) {
      return <strong>{use(data)}</strong>;
    }
    const resolved = resolveRoute(
      route.page(({ catalog, date, user }) => (
        <main>
          {catalog}:{date.toISOString()}
          <Suspense fallback="loading">
            <User data={user} />
          </Suspense>
        </main>
      ))
    );
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));
    const first = await app.handle(new Request("http://localhost/account")).then((r) => r.text());
    clearPprRouteCache();
    const second = await app.handle(new Request("http://localhost/account")).then((r) => r.text());
    expect(first).toContain("private-1");
    expect(second).toContain("private-2");
    expect(second).toContain("2026-01-01");
    expect(publicCalls).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.ttl).toBe(60);
    expect(writes[0]?.tags).toContain("catalog");
    expect(writes[0]?.tags).toContain("/account");
    expect(JSON.stringify([...values])).not.toContain("private-");
    values.clear();
    await app.handle(new Request("http://localhost/account")).then((r) => r.text());
    expect(publicCalls).toBe(2);
  });

  test("cross-instance invalidation removes tags from the cache-owning app", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ catalog: "Shoes" }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const resolved = resolveRoute(route);
    const owner = registerInstance(createInstance("/owner", "/owner/pages"));
    registerInstance(createInstance("/other", "/other/pages"));
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

    try {
      await withInstance(owner, () => app.handle(new Request("http://localhost/account")));
      expect(getAutoInvalidateRegistry(owner).pathsForTags(["catalog"])).toEqual(["/account"]);

      expect(invalidatePprRoute("/account", "page")).toBe(true);

      expect(getAutoInvalidateRegistry(owner).pathsForTags(["catalog"])).toEqual([]);
    } finally {
      clearPprRouteCache(owner);
      __clearInstanceRegistry();
    }
  });

  test("an ISR route caches public data while requestLoader reruns per request", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
      .requestLoader(({ cookies }) => {
        privateCalls += 1;
        return { user: cookies.get("session") };
      })
      .loader(() => {
        publicCalls += 1;
        return { catalog: "Shoes" };
      });
    function User({ data }: { data: Promise<unknown> }) {
      return <strong>{String(use(data))}</strong>;
    }
    const page = route.page(({ catalog, user }) => (
      <main>
        <h1>{catalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={user} />
        </Suspense>
      </main>
    ));
    const resolved = resolveRoute(page);
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

    const aliceResponse = await app.handle(
      new Request("http://localhost/account", { headers: { cookie: "session=alice" } })
    );
    const alice = await aliceResponse.text();
    const bob = await app
      .handle(new Request("http://localhost/account", { headers: { cookie: "session=bob" } }))
      .then((response) => response.text());

    expect(alice).toContain("Shoes");
    expect(alice).toContain("alice");
    expect(bob).toContain("bob");
    expect(aliceResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(2);
  });

  test("private GET snapshots stay isolated across a cached PPR document and SPA navigation", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const api = createClient(
      new Elysia().get("/cards", ({ request, set }) => {
        privateCalls += 1;
        const person = request.headers.get("x-person");
        set.headers["x-furin-query"] = JSON.stringify({
          id: "board.cards",
          scope: { boardId: "alpha" },
          session: person,
        });
        return { cards: [{ title: person }] };
      })
    );
    function Private({ data }: { data: Promise<{ cards: { title: string | null }[] }> }) {
      return <strong>{use(data).cards[0]?.title}</strong>;
    }
    const page = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 3600 })
      .requestLoader(({ cookies }) => ({
        user: api.cards
          .get({ headers: { "x-person": String(cookies.get("session")) } })
          .then(({ data, error }) => {
            if (error) {
              throw error;
            }
            return data;
          }),
      }))
      .loader(() => {
        publicCalls += 1;
        return { catalog: "Public" };
      })
      .page(({ catalog, user }) => (
        <main>
          {catalog}
          <Suspense fallback="pending">
            <Private data={user} />
          </Suspense>
        </main>
      ));
    const resolved = resolveRoute(page);
    const app = new Elysia()
      .use(createRoutePlugin(resolved, root, currentInstance().buildId))
      .use(createDataEndpoint([resolved], root));
    try {
      const alice = await app.handle(
        new Request("http://localhost/account", { headers: { cookie: "session=alice" } })
      );
      expect(alice.headers.get("cache-control")).toBe("private, no-store");
      expect(await alice.text()).toContain("alice");
      const bob = await app.handle(
        new Request("http://localhost/_furin/data?path=%2Faccount", {
          headers: { cookie: "session=bob" },
        })
      );
      expect(bob.headers.get("cache-control")).toBe("private, no-store");
      if (!bob.body) {
        throw new Error("Missing loader stream");
      }
      const parsed = await parseDeferredNdjson(bob.body, undefined);
      expect(await parsed.deferredPromises.user).toEqual({ cards: [{ title: "bob" }] });
      expect(parsed.syncData.__furinQueries).toMatchObject([
        {
          identity: { session: "bob" },
          data: { cards: [{ title: "bob" }] },
          bindings: [{ source: [], target: ["user"] }],
        },
      ]);
      const seeds = parsed.syncData.__furinQueries as QuerySeed[];
      expect(
        getAutoInvalidateRegistry().pathsForTags(seeds.map((seed) => queryTag(seed.identity)))
      ).toContain("/account");
      const again = await app.handle(
        new Request("http://localhost/account", { headers: { cookie: "session=alice" } })
      );
      const html = await again.text();
      expect(html).toContain("alice");
      expect(html).not.toContain("bob");
      expect(publicCalls).toBe(1);
      expect(privateCalls).toBe(3);
    } finally {
      getAutoInvalidateRegistry().unregisterPath("/account", "eden-request-queries");
    }
  });

  test("an SSR layout stays request scoped around an ISR page", async () => {
    let privateCalls = 0;
    let publicCalls = 0;
    function Session({ value }: { value: Promise<string | null> }) {
      return use(value);
    }
    const mixedRoot = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(({ request }) => {
        privateCalls += 1;
        return defer({ session: Promise.resolve(request.headers.get("cookie")) });
      })
      .layout(({ children, session }) => (
        <html lang="en">
          <head>
            <HeadContent />
          </head>
          <body>
            <aside>
              <Suspense fallback="Loading session">
                <Session value={session} />
              </Suspense>
            </aside>
            {children}
            <Scripts />
          </body>
        </html>
      ));
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "isr", revalidate: 60 })
      .loader(() => {
        publicCalls += 1;
        return { catalog: "Coffee" };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    const resolved: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/coffee.tsx",
      pattern: "/coffee",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const mixedRootRecord = { path: "/root.tsx", route: mixedRootRoute };
    const app = new Elysia()
      .use(createRoutePlugin(resolved, mixedRootRecord, "build-1"))
      .use(createDataEndpoint([resolved], mixedRootRecord));

    const alice = await app.handle(
      new Request("http://localhost/coffee", { headers: { cookie: "session=alice" } })
    );
    const aliceHtml = await alice.text();
    const bob = await app.handle(
      new Request("http://localhost/coffee", { headers: { cookie: "session=bob" } })
    );
    const bobHtml = await bob.text();

    expect(aliceHtml).toContain("session=alice");
    expect(bobHtml).toContain("session=bob");
    expect(bobHtml).not.toContain("session=alice");
    expect(alice.headers.get("cache-control")).toContain("no-store");
    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(2);

    const aliceData = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fcoffee", {
        headers: { cookie: "session=alice" },
      })
    );
    const bobData = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fcoffee", {
        headers: { cookie: "session=bob" },
      })
    );
    const alicePayload = await aliceData.text();
    const bobPayload = await bobData.text();
    expect(alicePayload).toContain("session=alice");
    expect(bobPayload).toContain("session=bob");
    expect(bobPayload).not.toContain("session=alice");
    expect(bobData.headers.get("cache-control")).toBe("private, no-store");
    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(4);

    revalidatePathForInstance(currentInstance(), "/coffee", "page");
    await app.handle(new Request("http://localhost/coffee")).then((response) => response.text());
    expect(publicCalls).toBe(2);
  });

  test("an ISR layout stays public around an SSR page", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const mixedRoot = defineRootRoute()
      .config({ mode: "isr", revalidate: 60 })
      .loader(() => {
        publicCalls += 1;
        return { catalog: "Coffee" };
      })
      .layout(({ children, catalog }) => (
        <html lang="en">
          <head>
            <HeadContent />
          </head>
          <body>
            <aside>{catalog}</aside>
            {children}
            <Scripts />
          </body>
        </html>
      ));
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "ssr" })
      .loader(async ({ request, catalog }) => {
        privateCalls += 1;
        return { session: request.headers.get("cookie"), title: await catalog };
      })
      .page(({ session, title }) => (
        <main>
          {title}: {session}
        </main>
      ));
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    page.mode = undefined;
    const resolved: ResolvedRoute = {
      mode: "ssr",
      page,
      path: "/private-coffee.tsx",
      pattern: "/private-coffee",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const app = new Elysia().use(
      createRoutePlugin(resolved, { path: "/root.tsx", route: mixedRootRoute }, "build-1")
    );

    const alice = await app.handle(
      new Request("http://localhost/private-coffee", { headers: { cookie: "alice" } })
    );
    const bob = await app.handle(
      new Request("http://localhost/private-coffee", { headers: { cookie: "bob" } })
    );
    expect(await alice.text()).toContain("alice");
    expect(await bob.text()).toContain("bob");
    expect(bob.headers.get("cache-control")).toContain("no-store");
    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(2);
  });

  test("an SSR page loader inherits SSG layout request data in documents and navigations", async () => {
    let publicCalls = 0;
    let requestCalls = 0;
    const mixedRoot = defineRootRoute()
      .config({ mode: "ssg" })
      .requestLoader(({ cookies }) => {
        requestCalls += 1;
        return { adminUser: cookies.get("session") };
      })
      .loader(() => {
        publicCalls += 1;
        return { siteName: "Coffee" };
      })
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
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "ssr" })
      .loader(async ({ adminUser, siteName }) => ({
        greeting: `${await siteName}: ${await adminUser}`,
      }))
      .page(({ greeting }) => <main>{greeting}</main>);
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    const resolved: ResolvedRoute = {
      mode: "ssr",
      page,
      path: "/private-coffee.tsx",
      pattern: "/private-coffee",
      requestKeys: ["adminUser"],
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const mixedRootRecord = { path: "/root.tsx", route: mixedRootRoute };
    const app = new Elysia()
      .use(createRoutePlugin(resolved, mixedRootRecord, "build-1"))
      .use(createDataEndpoint([resolved], mixedRootRecord));

    const checkRequest = async (user: string) => {
      const headers = { cookie: `session=${user}` };
      const document = await app.handle(
        new Request("http://localhost/private-coffee", { headers })
      );
      expect(await document.text()).toContain(`Coffee: ${user}`);
      expect(document.headers.get("cache-control")).toContain("no-store");

      const navigation = await app.handle(
        new Request("http://localhost/_furin/data?path=%2Fprivate-coffee", { headers })
      );
      expect(await navigation.text()).toContain(`Coffee: ${user}`);
    };
    await checkRequest("alice");
    await checkRequest("bob");
    expect(publicCalls).toBe(1);
    expect(requestCalls).toBe(4);
  });

  test("an ISR layout makes an SSG page document revalidate", async () => {
    let layoutCalls = 0;
    let pageCalls = 0;
    const mixedRoot = defineRootRoute()
      .config({ mode: "isr", revalidate: 30 })
      .loader(() => ({ layoutVersion: (layoutCalls += 1) }))
      .layout(({ children, layoutVersion }) => (
        <html lang="en">
          <head>
            <HeadContent />
          </head>
          <body>
            {layoutVersion}
            {children}
            <Scripts />
          </body>
        </html>
      ));
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "ssg" })
      .loader(() => ({ pageVersion: (pageCalls += 1) }))
      .page(({ pageVersion }) => <main>{pageVersion}</main>);
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    const resolved: ResolvedRoute = {
      mode: "ssg",
      page,
      path: "/mixed-ssg.tsx",
      pattern: "/mixed-ssg",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const app = new Elysia().use(
      createRoutePlugin(resolved, { path: "/root.tsx", route: mixedRootRoute }, "build-1")
    );

    const first = await app.handle(new Request("http://localhost/mixed-ssg"));
    expect(first.headers.get("cache-control")).toContain("s-maxage=30");
    await first.text();
    await app.handle(new Request("http://localhost/mixed-ssg")).then((response) => response.text());
    expect(layoutCalls).toBe(1);
    expect(pageCalls).toBe(1);
  });

  test("an SSG layout keeps its data while an ISR page document revalidates", async () => {
    let layoutCalls = 0;
    let pageCalls = 0;
    const mixedRoot = defineRootRoute()
      .config({ mode: "ssg" })
      .loader(() => ({ layoutVersion: (layoutCalls += 1) }))
      .layout(({ children, layoutVersion }) => (
        <html lang="en">
          <head>
            <HeadContent />
          </head>
          <body>
            {layoutVersion}
            {children}
            <Scripts />
          </body>
        </html>
      ));
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "isr", revalidate: 15 })
      .loader(() => ({ pageVersion: (pageCalls += 1) }))
      .page(({ pageVersion }) => <main>{pageVersion}</main>);
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    const resolved: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/mixed-isr.tsx",
      pattern: "/mixed-isr",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const app = new Elysia().use(
      createRoutePlugin(resolved, { path: "/root.tsx", route: mixedRootRoute }, "build-1")
    );

    const first = await app.handle(new Request("http://localhost/mixed-isr"));
    expect(first.headers.get("cache-control")).toContain("s-maxage=15");
    await first.text();
    await app.handle(new Request("http://localhost/mixed-isr")).then((response) => response.text());
    expect(layoutCalls).toBe(1);
    expect(pageCalls).toBe(1);
  });

  test("ISR layout and page keep their own revalidation intervals", async () => {
    let layoutCalls = 0;
    let pageCalls = 0;
    const mixedRoot = defineRootRoute()
      .config({ mode: "isr", revalidate: 0 })
      .loader(() => ({ layoutVersion: (layoutCalls += 1) }))
      .layout(({ children }) => children);
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "isr", revalidate: 30 })
      .loader(() => ({ pageVersion: (pageCalls += 1) }))
      .page(() => null);
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    const resolved: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/intervals.tsx",
      pattern: "/intervals",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const app = new Elysia().use(
      createDataEndpoint([resolved], { path: "/root.tsx", route: mixedRootRoute })
    );

    const first = await app.handle(new Request("http://localhost/_furin/data?path=%2Fintervals"));
    await first.text();
    const second = await app.handle(new Request("http://localhost/_furin/data?path=%2Fintervals"));
    await second.text();
    expect(first.headers.get("cache-control")).toContain("s-maxage=0");
    expect(layoutCalls).toBe(2);
    expect(pageCalls).toBe(1);
  });

  test("renews a cached child when its parent data changes", async () => {
    let layoutCalls = 0;
    let pageCalls = 0;
    const mixedRoot = defineRootRoute()
      .config({ mode: "isr", revalidate: 0 })
      .loader(() => ({ layoutVersion: (layoutCalls += 1) }))
      .layout(({ children }) => children);
    const mixedRootRoute = adaptDefinedLayout(mixedRoot, undefined);
    const mixedPage = defineRoute()
      .config({ layout: mixedRoot, mode: "isr", revalidate: 30 })
      .loader(async ({ layoutVersion }) => {
        pageCalls += 1;
        return { derivedVersion: await layoutVersion };
      })
      .page(() => null);
    const page = adaptDefinedPage(mixedPage, mixedRootRoute);
    const resolved: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/dependent-intervals.tsx",
      pattern: "/dependent-intervals",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const app = new Elysia().use(
      createDataEndpoint([resolved], { path: "/root.tsx", route: mixedRootRoute })
    );

    const first = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdependent-intervals")
    );
    const firstData = await first.text();
    const second = await app.handle(
      new Request("http://localhost/_furin/data?path=%2Fdependent-intervals")
    );
    const secondData = await second.text();
    expect(firstData).toContain("derivedVersion");
    expect(secondData).toContain("derivedVersion");
    expect(layoutCalls).toBe(2);
    expect(pageCalls).toBe(2);
  });

  test("observes shared invalidation before reusing a public segment", async () => {
    let publicCalls = 0;
    const privateRoot = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(({ request }) => ({ session: request.headers.get("cookie") }))
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
    const rootRoute = adaptDefinedLayout(privateRoot, undefined);
    const terminal = defineRoute()
      .config({ layout: privateRoot, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .loader(() => ({ catalog: (publicCalls += 1) }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/shared-mixed.tsx",
      pattern: "/shared-mixed",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
      tags: ["catalog"],
    };
    const owner = registerInstance(createInstance("", "/shared-mixed/pages"));
    owner.buildId = "build-1";
    const cache = createMemoryPageCache();
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(
      createRoutePlugin(route, { path: "/root.tsx", route: rootRoute }, owner.buildId)
    );

    try {
      await withInstance(owner, () => app.handle(new Request("http://localhost/shared-mixed")));
      await withInstance(owner, () => app.handle(new Request("http://localhost/shared-mixed")));
      expect(publicCalls).toBe(1);
      await cache.invalidate({ kind: "tags", scope: "", tags: ["catalog"] });
      await withInstance(owner, () => app.handle(new Request("http://localhost/shared-mixed")));
      expect(publicCalls).toBe(2);
    } finally {
      clearMixedPublicCache(owner);
      resetPageCacheAdapter(owner);
      __clearInstanceRegistry();
    }
  });

  test("renders mixed routes when the shared segment cache is unavailable", async () => {
    const unavailable = (): Promise<never> => Promise.reject(new Error("cache unavailable"));
    const cache: PageCacheAdapter = {
      acquire: unavailable,
      commit: unavailable,
      invalidate: unavailable,
      read: unavailable,
      release: unavailable,
    };
    const privateRoot = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(({ request }) => ({ session: request.headers.get("cookie") }))
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
    const rootRoute = adaptDefinedLayout(privateRoot, undefined);
    const terminal = defineRoute()
      .config({ layout: privateRoot, mode: "isr", revalidate: 60 })
      .loader(() => ({ catalog: "Fresh catalog" }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/unavailable-mixed.tsx",
      pattern: "/unavailable-mixed",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const owner = registerInstance(createInstance("", "/unavailable-mixed/pages"));
    owner.buildId = "build-1";
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(
      createRoutePlugin(route, { path: "/root.tsx", route: rootRoute }, owner.buildId)
    );

    try {
      const response = await withInstance(owner, () =>
        app.handle(new Request("http://localhost/unavailable-mixed"))
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).toContain("Fresh catalog");
    } finally {
      clearMixedPublicCache(owner);
      resetPageCacheAdapter(owner);
      __clearInstanceRegistry();
    }
  });

  test("does not restore a public segment invalidated during its loader", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let publicCalls = 0;
    const privateRoot = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => ({ session: "private" }))
      .layout(({ children }) => children);
    const rootRoute = adaptDefinedLayout(privateRoot, undefined);
    const terminal = defineRoute()
      .config({ layout: privateRoot, mode: "isr", revalidate: 60 })
      .loader(async () => {
        publicCalls += 1;
        if (publicCalls === 1) {
          started.resolve();
          await release.promise;
        }
        return { catalog: publicCalls };
      })
      .page(() => null);
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/inflight-mixed.tsx",
      pattern: "/inflight-mixed",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
    };
    const owner = registerInstance(createInstance("", "/inflight-mixed/pages"));
    owner.buildId = "build-1";
    const app = new Elysia().use(
      createDataEndpoint([route], { path: "/root.tsx", route: rootRoute })
    );

    try {
      const first = withInstance(owner, () =>
        app.handle(new Request("http://localhost/_furin/data?path=%2Finflight-mixed"))
      );
      await started.promise;
      revalidatePathForInstance(owner, "/inflight-mixed", "page");
      release.resolve();
      await first;
      await withInstance(owner, () =>
        app.handle(new Request("http://localhost/_furin/data?path=%2Finflight-mixed"))
      );
      expect(publicCalls).toBe(2);
    } finally {
      release.resolve();
      clearMixedPublicCache(owner);
      __clearInstanceRegistry();
    }
  });

  test("does not restore a shared segment invalidated during its loader", async () => {
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let publicCalls = 0;
    const privateRoot = defineRootRoute()
      .config({ mode: "ssr" })
      .loader(() => ({ session: "private" }))
      .layout(({ children }) => children);
    const rootRoute = adaptDefinedLayout(privateRoot, undefined);
    const terminal = defineRoute()
      .config({ layout: privateRoot, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .loader(async () => {
        publicCalls += 1;
        if (publicCalls === 1) {
          started.resolve();
          await release.promise;
        }
        return { catalog: publicCalls };
      })
      .page(() => null);
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "isr",
      page,
      path: "/inflight-shared-mixed.tsx",
      pattern: "/inflight-shared-mixed",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
      tags: ["catalog"],
    };
    const owner = registerInstance(createInstance("", "/inflight-shared-mixed/pages"));
    owner.buildId = "build-1";
    const cache = createMemoryPageCache();
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(
      createDataEndpoint([route], { path: "/root.tsx", route: rootRoute })
    );

    try {
      const first = withInstance(owner, () =>
        app.handle(new Request("http://localhost/_furin/data?path=%2Finflight-shared-mixed"))
      );
      await started.promise;
      await cache.invalidate({ kind: "tags", scope: "", tags: ["catalog"] });
      release.resolve();
      await first;
      await withInstance(owner, () =>
        app.handle(new Request("http://localhost/_furin/data?path=%2Finflight-shared-mixed"))
      );
      expect(publicCalls).toBe(2);
    } finally {
      release.resolve();
      clearMixedPublicCache(owner);
      resetPageCacheAdapter(owner);
      __clearInstanceRegistry();
    }
  });

  test("evicting a segment keeps the document's tag invalidation", async () => {
    let catalog = "Coffee";
    const publicRoot = defineRootRoute()
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
      .loader(() => ({ site: "Shop" }))
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
    const rootRoute = adaptDefinedLayout(publicRoot, undefined);
    const terminal = defineRoute()
      .config({ layout: publicRoot, mode: "ssg" })
      .loader(() => ({ catalog }))
      .page(({ catalog: value }) => <main>{value}</main>);
    const page = adaptDefinedPage(terminal, rootRoute);
    const route: ResolvedRoute = {
      mode: "ssg",
      page,
      path: "/tagged-mixed.tsx",
      pattern: "/tagged-mixed",
      routeChain: collectRouteChainFromRoute(page._route),
      segmentBoundaries: [],
      tags: ["catalog"],
    };
    const owner = registerInstance(createInstance("", "/tagged-mixed/pages"));
    owner.buildId = "build-1";
    const app = new Elysia().use(
      createRoutePlugin(route, { path: "/root.tsx", route: rootRoute }, owner.buildId)
    );

    try {
      const first = await withInstance(owner, () =>
        app.handle(new Request("http://localhost/tagged-mixed"))
      );
      expect(await first.text()).toContain("Coffee");
      clearMixedPublicCache(owner);
      catalog = "Tea";
      expect(await revalidateTag("catalog")).toBe(true);
      const fresh = await withInstance(owner, () =>
        app.handle(new Request("http://localhost/tagged-mixed"))
      );
      expect(await fresh.text()).toContain("Tea");
    } finally {
      clearMixedPublicCache(owner);
      revalidatePathForInstance(owner, "/tagged-mixed", "page");
      __clearInstanceRegistry();
    }
  });

  test("keys PPR public shells by query string", async () => {
    let publicCalls = 0;
    const route = defineRoute()
      .config({
        layout: rootTerminal,
        mode: "isr",
        query: t.Object({ view: t.Optional(t.String()) }),
        revalidate: 60,
      })
      .requestLoader(() => ({ user: "alice" }))
      .loader(({ query }) => {
        publicCalls += 1;
        return { view: query.view ?? "" };
      });
    function User({ data }: { data: Promise<string> }) {
      return <strong>{use(data)}</strong>;
    }
    const page = route.page(({ user, view }) => (
      <main>
        <h1>{view}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={user} />
        </Suspense>
      </main>
    ));
    const resolved = resolveRoute(page);
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

    const alpha = await app
      .handle(new Request("http://localhost/account?view=alpha"))
      .then((response) => response.text());
    const beta = await app
      .handle(new Request("http://localhost/account?view=beta"))
      .then((response) => response.text());

    expect(alpha).toContain("alpha");
    expect(beta).toContain("beta");
    expect(publicCalls).toBe(2);

    expect(invalidatePprRoute("/account", "page")).toBe(true);
    await app.handle(new Request("http://localhost/account?view=alpha"));
    expect(publicCalls).toBe(3);
  });

  test("revalidateTag invalidates a PPR public shell", async () => {
    let catalog = "Shoes";
    let publicCalls = 0;
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => {
        publicCalls += 1;
        return { catalog };
      });
    function User({ data }: { data: Promise<string> }) {
      return <strong>{use(data)}</strong>;
    }
    const page = route.page(({ catalog: loadedCatalog, user }) => (
      <main>
        <h1>{loadedCatalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={user} />
        </Suspense>
      </main>
    ));
    const resolved = resolveRoute(page);
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

    const first = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());
    catalog = "Boots";
    const stale = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(first).toContain("Shoes");
    expect(stale).toContain("Shoes");
    expect(publicCalls).toBe(1);
    expect(await revalidateTag("catalog")).toBe(true);

    const fresh = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(fresh).toContain("Boots");
    expect(publicCalls).toBe(2);
  });

  test("uses the shared page cache for PPR public artifacts", async () => {
    let publicCalls = 0;
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => {
        publicCalls += 1;
        return { catalog: publicCalls };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const resolved = resolveRoute(route);
    const owner = registerInstance(createInstance("", "/shared-ppr/pages"));
    owner.buildId = "build-1";
    const cache = createMemoryPageCache();
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(createRoutePlugin(resolved, root, owner.buildId));

    try {
      await withInstance(owner, () => app.handle(new Request("http://localhost/account")));
      await withInstance(owner, () => app.handle(new Request("http://localhost/account")));
      expect(publicCalls).toBe(1);
      await cache.invalidate({ kind: "tags", scope: "", tags: ["catalog"] });
      await withInstance(owner, () => app.handle(new Request("http://localhost/account")));
    } finally {
      resetPageCacheAdapter(owner);
      clearPprRouteCache(owner);
      __clearInstanceRegistry();
    }

    expect(publicCalls).toBe(2);
  });

  test("shared PPR query discovery stores an artifact on the next render", async () => {
    let reads = 0;
    const identity = { id: "catalog", scope: {}, session: "public" };
    const api = createClient(
      new Elysia().get("/catalog", ({ set }) => {
        reads += 1;
        set.headers["x-furin-query"] = JSON.stringify(identity);
        return { title: "Public" };
      })
    );
    const page = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 3600 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(async () => ({ catalog: (await api.catalog.get()).data }))
      .page(({ catalog }) => <main>{catalog?.title}</main>);
    const resolved = resolveRoute(page);
    const owner = registerInstance(createInstance("", "/query-ppr/pages"));
    owner.buildId = "build-1";
    const cache = createMemoryPageCache();
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(createRoutePlugin(resolved, root, owner.buildId));
    const request = () =>
      withInstance(owner, () => app.handle(new Request("http://localhost/account")));
    try {
      await (await request()).text();
      await (await request()).text();
      await (await request()).text();
      expect(reads).toBe(2);
      await cache.invalidate({ kind: "tags", scope: "", tags: [queryTag(identity)] });
      await (await request()).text();
      expect(reads).toBe(3);
    } finally {
      resetPageCacheAdapter(owner);
      clearPprRouteCache(owner);
      getAutoInvalidateRegistry(owner).unregisterPath("/account");
      __clearInstanceRegistry();
    }
  });

  test("external prerender bypasses shared and local PPR artifacts", async () => {
    let publicCalls = 0;
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => {
        publicCalls += 1;
        return { catalog: publicCalls };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const resolved = resolveRoute(route);
    const owner = registerInstance(createInstance("", "/external-ppr/pages"));
    owner.buildId = "build-1";
    const cache = createMemoryPageCache();
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(createRoutePlugin(resolved, root, owner.buildId));

    try {
      await withInstance(owner, () => app.handle(new Request("http://localhost/account")));
      const request = markExternalPrerenderRequest(new Request("http://localhost/account"));
      await withInstance(owner, () => app.handle(request));
      expect(publicCalls).toBe(2);
    } finally {
      resetPageCacheAdapter(owner);
      clearPprRouteCache(owner);
      __clearInstanceRegistry();
    }
  });

  test("serves stale shared PPR while regeneration runs in the background", async () => {
    const gate = Promise.withResolvers<void>();
    let publicCalls = 0;
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(async () => {
        publicCalls += 1;
        if (publicCalls === 2) {
          await gate.promise;
        }
        return { catalog: publicCalls };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const resolved = resolveRoute(route);
    const owner = registerInstance(createInstance("", "/stale-shared-ppr/pages"));
    owner.buildId = "build-1";
    const cache = createMemoryPageCache();
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(createRoutePlugin(resolved, root, owner.buildId));
    const identity: PageCacheIdentity = {
      buildId: owner.buildId,
      key: "isr:/account",
      mode: "ppr",
      path: "/account",
      scope: "",
      tags: [],
    };

    try {
      await withInstance(owner, () => app.handle(new Request("http://localhost/account")));
      const stored = await cache.read(identity);
      if (stored === null) {
        throw new Error("Expected the initial shared PPR artifact");
      }
      const artifact = JSON.parse(stored.payload) as { cachedAt: number };
      artifact.cachedAt = 0;
      await cache.invalidate({ kind: "path", path: "/account", scope: "", type: "page" });
      const lease = await cache.acquire({ identity, leaseMs: 30_000 });
      if (lease === null) {
        throw new Error("Expected a lease for the stale PPR artifact");
      }
      await cache.commit({
        entry: { ...stored, payload: JSON.stringify(artifact) },
        identity,
        lease,
      });

      const response = withInstance(owner, () =>
        app.handle(new Request("http://localhost/account"))
      );
      const settled = await Promise.race([
        response.then((value) => ({ type: "response" as const, value })),
        Bun.sleep(100).then(() => ({ type: "timeout" as const })),
      ]);
      expect(settled.type).toBe("response");
      expect(publicCalls).toBe(2);
      if (settled.type === "response") {
        expect(await settled.value.text()).toContain("1");
      }
    } finally {
      gate.resolve();
      resetPageCacheAdapter(owner);
      clearPprRouteCache(owner);
      __clearInstanceRegistry();
    }
  });

  test("serves PPR with no-store when the shared page cache is unavailable", async () => {
    const unavailable = (): Promise<never> => Promise.reject(new Error("cache unavailable"));
    const cache: PageCacheAdapter = {
      acquire: unavailable,
      commit: unavailable,
      invalidate: unavailable,
      read: unavailable,
      release: unavailable,
    };
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ catalog: "Fresh catalog" }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const resolved = resolveRoute(route);
    const owner = registerInstance(createInstance("", "/unavailable-ppr/pages"));
    owner.buildId = "build-1";
    setPageCacheAdapter(owner, cache);
    const app = new Elysia().use(createRoutePlugin(resolved, root, owner.buildId));

    try {
      const response = await withInstance(owner, () =>
        app.handle(new Request("http://localhost/account"))
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toContain("Fresh catalog");
    } finally {
      resetPageCacheAdapter(owner);
      clearPprRouteCache(owner);
      __clearInstanceRegistry();
    }
  });

  test("streams a rejected request field instead of aborting the PPR response", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
      .requestLoader((): { user: string } => {
        throw new Error("private boom");
      })
      .loader(() => ({ catalog: "Shoes" }));
    function User({ data }: { data: Promise<string> }) {
      return <strong>{String(use(data))}</strong>;
    }
    const page = route.page(({ catalog, user }) => (
      <main>
        <h1>{catalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={user} />
        </Suspense>
      </main>
    ));
    const resolved = resolveRoute(page);
    const app = new Elysia().use(createRoutePlugin(resolved, root, "build-1"));

    const html = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(html).toContain("Shoes");
    expect(html).toContain("__FURIN_ROUTE_FRAME_STREAM__");
    expect(html).toContain('\\"key\\":\\"user\\"');
    expect(html).toContain('\\"type\\":\\"defer-reject\\"');
  });
});
