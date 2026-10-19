import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { Suspense, use } from "react";
import { createClient, defer } from "../../../src/client.ts";
import { Await, defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { revalidateTag } from "../../../src/server/auto-invalidate";
import { getAutoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
import { revalidatePathForInstance } from "../../../src/server/cache/invalidation.ts";
import {
  createMemoryPageCache,
  type PageCacheAdapter,
  type PageCacheIdentity,
} from "../../../src/server/cache/page-cache.ts";
import {
  resetRuntimeCacheProvider,
  setRuntimeCacheProvider,
} from "../../../src/server/cache/runtime-cache.ts";
import { markExternalPrerenderRequest } from "../../../src/server/external-prerender.ts";
import { createInstance, registerInstance } from "../../../src/server/instance.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { clearMixedPublicCache } from "../../../src/server/render/mixed-cache.ts";
import { clearPprRouteCache, invalidatePprRoute } from "../../../src/server/render/ppr-route";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { type QuerySeed, queryTag } from "../../../src/shared/sync-query.ts";
import { mountProductionApp, type ProductionPage } from "../../support/production-app.ts";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

afterEach(async () => {
  clearPprRouteCache();
  clearMixedPublicCache();
  resetRuntimeCacheProvider();
  __resetCompileContext();
  await Promise.resolve();
});
const STATE_LENGTH_RE = /state-length=(\d+)/;
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

// Layouts of the inheritance tests, wired through FileRoutes as
// furin-env.d.ts would wire them from the pages tree.
const createCatalogRoot = (load: () => void) =>
  defineRootRoute()
    .config({ mode: "isr", revalidate: 60 })
    .loader(() => {
      load();
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
const createAdminRoot = (onRequest: () => void, onLoad: () => void) =>
  defineRootRoute()
    .config({ mode: "ssg" })
    .requestLoader(({ cookies }) => {
      onRequest();
      return { adminUser: cookies.get("session") };
    })
    .loader(() => {
      onLoad();
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
const createVersionRoot = (version: () => number) =>
  defineRootRoute()
    .config({ mode: "isr", revalidate: 0 })
    .loader(() => ({ layoutVersion: version() }))
    .layout(({ children }) => children);

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/ppr/admin": {
      kind: "page";
      parent: ReturnType<typeof createAdminRoot>;
      pathParams: NonNullable<unknown>;
    };
    "/ppr/catalog": {
      kind: "page";
      parent: ReturnType<typeof createCatalogRoot>;
      pathParams: NonNullable<unknown>;
    };
    "/ppr/version": {
      kind: "page";
      parent: ReturnType<typeof createVersionRoot>;
      pathParams: NonNullable<unknown>;
    };
  }
}

/** Mounts `route` at `/account` below the shared root through a production `furin()`. */
function mountAccount(route: ProductionPage["route"], pageCache: PageCacheAdapter | undefined) {
  const hasRequestLoader = (route as { requestLoader?: unknown }).requestLoader !== undefined;
  return mountProductionApp({
    buildId: "build-1",
    pageCache,
    pages: [{ pattern: "/account", requestKeys: hasRequestLoader ? ["user"] : [], route }],
    root: rootTerminal,
  });
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
  const { app } = await mountAccount(
    defineRoute("/")
      .config({ mode: "ssr" })
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
      )),
    undefined
  );
  function User({ data }: { data: Promise<unknown> }) {
    return <strong>{String(use(data))}</strong>;
  }
  const response = await app.handle(
    new Request("http://localhost/account", { headers: { cookie: "session=Alice" } })
  );
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("cache-control")).not.toContain("public");
  expect(await response.text()).toContain("Alice");
});

test("SSR exposes deferred fields as individual promises", async () => {
  let optionalWasAbsent = false;
  const { app } = await mountAccount(
    defineRoute("/")
      .config({ mode: "ssr" })
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
      }),
    undefined
  );
  function PrivateUser({ user }: { user: Promise<string> }) {
    return <strong>{use(user)}</strong>;
  }
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
      const { app } = await mountAccount(
        defineRoute("/")
          .config({ mode: "isr", revalidate: 60 })
          .requestLoader(() => ({ user: "alice" }))
          .loader(() => ({ catalog: "Fresh catalog" }))
          .page(({ catalog }) => <main>{catalog}</main>),
        undefined
      );
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
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
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
    const { app } = await mountAccount(
      route.page(({ catalog, date, user }) => (
        <main>
          {catalog}:{date.toISOString()}
          <Suspense fallback="loading">
            <User data={user} />
          </Suspense>
        </main>
      )),
      undefined
    );
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

  test("keeps public artifacts of deployments sharing one provider store apart", async () => {
    const values = new Map<string, unknown>();
    const store = {
      delete: () => Promise.resolve(),
      expireTag: () => Promise.resolve(),
      get: (key: string) => Promise.resolve(values.get(key) ?? null),
      set: (key: string, value: unknown) => {
        values.set(key, value);
        return Promise.resolve();
      },
    };
    let publicCalls = 0;
    const { app } = await mountAccount(
      defineRoute("/")
        .config({ mode: "isr", revalidate: 60 })
        .requestLoader(() => ({ user: "alice" }))
        .loader(() => ({ catalog: (publicCalls += 1) }))
        .page(({ catalog }) => <main>{catalog}</main>),
      undefined
    );
    const render = async (scope: string) => {
      setRuntimeCacheProvider({ getCache: () => store, scope });
      clearPprRouteCache();
      await app.handle(new Request("http://localhost/account")).then((r) => r.text());
    };

    await render("deployment-1");
    await render("deployment-2");
    await render("deployment-1");

    expect(publicCalls).toBe(2);
  });

  test("cross-instance invalidation removes tags from the cache-owning app", async () => {
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ catalog: "Shoes" }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const { app, instance } = await mountAccount(route, undefined);
    registerInstance(createInstance("/other", "/other/pages"));

    await app.handle(new Request("http://localhost/account"));
    expect(getAutoInvalidateRegistry(instance).pathsForTags(["catalog"])).toEqual(["/account"]);

    expect(invalidatePprRoute("/account", "page")).toBe(true);

    expect(getAutoInvalidateRegistry(instance).pathsForTags(["catalog"])).toEqual([]);
  });

  test("an ISR route caches public data while requestLoader reruns per request", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60 })
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
    const { app } = await mountAccount(page, undefined);

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

  test("a request field read through <Await> resumes into its Suspense boundary", async () => {
    const { app } = await mountAccount(
      defineRoute("/")
        .config({ mode: "ssg" })
        .requestLoader(({ cookies }) => ({ user: cookies.get("session") }))
        .loader(() => ({ catalog: "Shoes" }))
        .page(({ catalog, user }) => (
          <main>
            <h1>{catalog}</h1>
            <Suspense fallback={<span>Loading</span>}>
              <Await resolve={user}>{(value) => <strong>{String(value)}</strong>}</Await>
            </Suspense>
          </main>
        )),
      undefined
    );

    const response = await app.handle(
      new Request("http://localhost/account", { headers: { cookie: "session=alice" } })
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("<strong>alice</strong>");
  }, 5000);

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
    const page = defineRoute("/")
      .config({ mode: "isr", revalidate: 3600 })
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
    const { app, instance } = await mountAccount(page, undefined);
    try {
      const alice = await app.handle(
        new Request("http://localhost/account", { headers: { cookie: "session=alice" } })
      );
      expect(alice.headers.get("cache-control")).toBe("private, no-store");
      expect(await alice.text()).toContain("alice");
      const bob = await app.handle(
        new Request("http://localhost/account?_furin=data", {
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
        getAutoInvalidateRegistry(instance).pathsForTags(
          seeds.map((seed) => queryTag(seed.identity))
        )
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
      getAutoInvalidateRegistry(instance).unregisterPath("/account", "eden-request-queries");
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
    const mixedPage = defineRoute("/mixed")
      .config({ mode: "isr", revalidate: 60 })
      .loader(() => {
        publicCalls += 1;
        return { catalog: "Coffee" };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const { app, instance } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/coffee", route: mixedPage }],
      root: mixedRoot,
    });

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
      new Request("http://localhost/coffee?_furin=data", {
        headers: { cookie: "session=alice" },
      })
    );
    const bobData = await app.handle(
      new Request("http://localhost/coffee?_furin=data", {
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

    revalidatePathForInstance(instance, "/coffee", "page");
    await app.handle(new Request("http://localhost/coffee")).then((response) => response.text());
    expect(publicCalls).toBe(2);
  });

  test("an ISR layout stays public around an SSR page", async () => {
    let publicCalls = 0;
    let privateCalls = 0;
    const mixedRoot = createCatalogRoot(() => {
      publicCalls += 1;
    });
    const mixedPage = defineRoute("/ppr/catalog")
      .config({ mode: "ssr" })
      .loader(async ({ request, catalog }) => {
        privateCalls += 1;
        return { session: request.headers.get("cookie"), title: await catalog };
      })
      .page(({ session, title }) => (
        <main>
          {title}: {session}
        </main>
      ));
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/private-coffee", route: mixedPage }],
      root: mixedRoot,
    });

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

  for (const declared of [false, true]) {
    test(`an ISR layout around an SSR page keys on ${declared ? "declared" : "no"} query params`, async () => {
      const publicQueries: unknown[] = [];
      const privateQueries: unknown[] = [];
      const mixedRoot = defineRootRoute()
        .config({ mode: "isr", revalidate: 60 })
        .loader(({ query }) => {
          publicQueries.push({ ...query });
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
      const recordPrivateQuery = ({ query }: { query: object }) => {
        privateQueries.push({ ...query });
        return {};
      };
      const mixedPage = declared
        ? defineRoute("/")
            .config({
              mode: "ssr",
              query: t.Object({ sort: t.Optional(t.String()), view: t.Optional(t.String()) }),
            })
            .loader(recordPrivateQuery)
            .page(() => <main>menu</main>)
        : defineRoute("/")
            .config({ mode: "ssr" })
            .loader(recordPrivateQuery)
            .page(() => <main>menu</main>);
      const { app } = await mountProductionApp({
        buildId: "build-1",
        pages: [{ pattern: "/menu", route: mixedPage }],
        root: mixedRoot,
      });

      for (const search of [
        "?view=alpha&sort=new",
        "?sort=new&view=alpha&junk=1",
        "?utm_source=x&view=alpha&sort=new",
        "?view=beta&sort=new",
      ]) {
        // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
        const response = await app.handle(new Request(`http://localhost/menu${search}`));
        expect(response.status).toBe(200);
      }

      expect(publicQueries).toEqual(
        declared
          ? [
              { sort: "new", view: "alpha" },
              { sort: "new", view: "beta" },
            ]
          : [{}]
      );
      expect(privateQueries).toHaveLength(4);
      if (!declared) {
        expect(privateQueries[1]).toEqual({ junk: "1", sort: "new", view: "alpha" });
      }
    });
  }

  test("an ISR layout around an SSR page keys on declared query values as the schema decodes them", async () => {
    const publicQueries: unknown[] = [];
    const mixedRoot = defineRootRoute()
      .config({ mode: "isr", revalidate: 60 })
      .loader(({ query }) => {
        publicQueries.push({ ...query });
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
    const mixedPage = defineRoute("/mixed")
      .config({
        mode: "ssr",
        query: t.Object({ page: t.Number({ default: 1 }) }),
      })
      .loader(() => ({}))
      .page(() => <main>menu</main>);
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/menu", route: mixedPage }],
      root: mixedRoot,
    });

    for (const search of ["?page=02", "?page=2.0", "?page=2", "", "?page=01"]) {
      // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
      const response = await app.handle(new Request(`http://localhost/menu${search}`));
      expect(response.status).toBe(200);
    }

    expect(publicQueries).toEqual([{ page: 2 }, { page: 1 }]);
  });

  test("an SSR page loader inherits SSG layout request data in documents and navigations", async () => {
    let publicCalls = 0;
    let requestCalls = 0;
    const mixedRoot = createAdminRoot(
      () => {
        requestCalls += 1;
      },
      () => {
        publicCalls += 1;
      }
    );
    const mixedPage = defineRoute("/ppr/admin")
      .config({ mode: "ssr" })
      .loader(async ({ adminUser, siteName }) => ({
        greeting: `${await siteName}: ${await adminUser}`,
      }))
      .page(({ greeting }) => <main>{greeting}</main>);
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/private-coffee", requestKeys: ["adminUser"], route: mixedPage }],
      root: mixedRoot,
    });

    const checkRequest = async (user: string) => {
      const headers = { cookie: `session=${user}` };
      const document = await app.handle(
        new Request("http://localhost/private-coffee", { headers })
      );
      expect(await document.text()).toContain(`Coffee: ${user}`);
      expect(document.headers.get("cache-control")).toContain("no-store");

      const navigation = await app.handle(
        new Request("http://localhost/private-coffee?_furin=data", { headers })
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
    const mixedPage = defineRoute("/mixed")
      .config({ mode: "ssg" })
      .loader(() => ({ pageVersion: (pageCalls += 1) }))
      .page(({ pageVersion }) => <main>{pageVersion}</main>);
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/mixed-ssg", route: mixedPage }],
      root: mixedRoot,
    });

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
    const mixedPage = defineRoute("/mixed")
      .config({ mode: "isr", revalidate: 15 })
      .loader(() => ({ pageVersion: (pageCalls += 1) }))
      .page(({ pageVersion }) => <main>{pageVersion}</main>);
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/mixed-isr", route: mixedPage }],
      root: mixedRoot,
    });

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
    const mixedRoot = createVersionRoot(() => {
      layoutCalls += 1;
      return layoutCalls;
    });
    const mixedPage = defineRoute("/ppr/version")
      .config({ mode: "isr", revalidate: 30 })
      .loader(() => ({ pageVersion: (pageCalls += 1) }))
      .page(() => null);
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/intervals", route: mixedPage }],
      root: mixedRoot,
    });

    const first = await app.handle(new Request("http://localhost/intervals?_furin=data"));
    await first.text();
    const second = await app.handle(new Request("http://localhost/intervals?_furin=data"));
    await second.text();
    expect(first.headers.get("cache-control")).toContain("s-maxage=0");
    expect(layoutCalls).toBe(2);
    expect(pageCalls).toBe(1);
  });

  test("renews a cached child when its parent data changes", async () => {
    let layoutCalls = 0;
    let pageCalls = 0;
    const mixedRoot = createVersionRoot(() => {
      layoutCalls += 1;
      return layoutCalls;
    });
    const mixedPage = defineRoute("/ppr/version")
      .config({ mode: "isr", revalidate: 30 })
      .loader(async ({ layoutVersion }) => {
        pageCalls += 1;
        return { derivedVersion: await layoutVersion };
      })
      .page(() => null);
    const { app } = await mountProductionApp({
      buildId: "build-1",
      pages: [{ pattern: "/dependent-intervals", route: mixedPage }],
      root: mixedRoot,
    });

    const first = await app.handle(new Request("http://localhost/dependent-intervals?_furin=data"));
    const firstData = await first.text();
    const second = await app.handle(
      new Request("http://localhost/dependent-intervals?_furin=data")
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
    const terminal = defineRoute("/terminal")
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
      .loader(() => ({ catalog: (publicCalls += 1) }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const cache = createMemoryPageCache();
    const { app, instance } = await mountProductionApp({
      buildId: "build-1",
      pageCache: cache,
      pages: [{ pattern: "/shared-mixed", route: terminal }],
      root: privateRoot,
    });

    try {
      await app.handle(new Request("http://localhost/shared-mixed"));
      await app.handle(new Request("http://localhost/shared-mixed"));
      expect(publicCalls).toBe(1);
      await cache.invalidate({ kind: "tags", scope: "", tags: ["catalog"] });
      await app.handle(new Request("http://localhost/shared-mixed"));
      expect(publicCalls).toBe(2);
    } finally {
      clearMixedPublicCache(instance);
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
    const terminal = defineRoute("/terminal")
      .config({ mode: "isr", revalidate: 60 })
      .loader(() => ({ catalog: "Fresh catalog" }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const { app, instance } = await mountProductionApp({
      buildId: "build-1",
      pageCache: cache,
      pages: [{ pattern: "/unavailable-mixed", route: terminal }],
      root: privateRoot,
    });

    try {
      const response = await app.handle(new Request("http://localhost/unavailable-mixed"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(await response.text()).toContain("Fresh catalog");
    } finally {
      clearMixedPublicCache(instance);
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
    const terminal = defineRoute("/terminal")
      .config({ mode: "isr", revalidate: 60 })
      .loader(async () => {
        publicCalls += 1;
        if (publicCalls === 1) {
          started.resolve();
          await release.promise;
        }
        return { catalog: publicCalls };
      })
      .page(() => null);
    const { app, instance } = await mountProductionApp({
      buildId: "build-1",
      pageCache: undefined,
      pages: [{ pattern: "/inflight-mixed", route: terminal }],
      root: privateRoot,
    });

    try {
      const first = app.handle(new Request("http://localhost/inflight-mixed?_furin=data"));
      await started.promise;
      revalidatePathForInstance(instance, "/inflight-mixed", "page");
      release.resolve();
      await first;
      await app.handle(new Request("http://localhost/inflight-mixed?_furin=data"));
      expect(publicCalls).toBe(2);
    } finally {
      release.resolve();
      clearMixedPublicCache(instance);
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
    const terminal = defineRoute("/terminal")
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
      .loader(async () => {
        publicCalls += 1;
        if (publicCalls === 1) {
          started.resolve();
          await release.promise;
        }
        return { catalog: publicCalls };
      })
      .page(() => null);
    const cache = createMemoryPageCache();
    const { app, instance } = await mountProductionApp({
      buildId: "build-1",
      pageCache: cache,
      pages: [{ pattern: "/inflight-shared-mixed", route: terminal }],
      root: privateRoot,
    });

    try {
      const first = app.handle(new Request("http://localhost/inflight-shared-mixed?_furin=data"));
      await started.promise;
      await cache.invalidate({ kind: "tags", scope: "", tags: ["catalog"] });
      release.resolve();
      await first;
      await app.handle(new Request("http://localhost/inflight-shared-mixed?_furin=data"));
      expect(publicCalls).toBe(2);
    } finally {
      release.resolve();
      clearMixedPublicCache(instance);
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
    const terminal = defineRoute("/terminal")
      .config({ mode: "ssg" })
      .loader(() => ({ catalog }))
      .page(({ catalog: value }) => <main>{value}</main>);
    const { app, instance } = await mountProductionApp({
      buildId: "build-1",
      pageCache: undefined,
      pages: [{ pattern: "/tagged-mixed", route: terminal }],
      root: publicRoot,
    });

    try {
      const first = await app.handle(new Request("http://localhost/tagged-mixed"));
      expect(await first.text()).toContain("Coffee");
      clearMixedPublicCache(instance);
      catalog = "Tea";
      expect(await revalidateTag("catalog")).toBe(true);
      const fresh = await app.handle(new Request("http://localhost/tagged-mixed"));
      expect(await fresh.text()).toContain("Tea");
    } finally {
      clearMixedPublicCache(instance);
      revalidatePathForInstance(instance, "/tagged-mixed", "page");
    }
  });

  test("keys PPR public shells by query string", async () => {
    let publicCalls = 0;
    const route = defineRoute("/")
      .config({
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
    const { app } = await mountAccount(page, undefined);

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

  test("keys PPR public shells on declared query params only, in canonical order", async () => {
    const observed: unknown[] = [];
    const route = defineRoute("/")
      .config({
        mode: "isr",
        query: t.Object({ sort: t.Optional(t.String()), view: t.Optional(t.String()) }),
        revalidate: 60,
      })
      .requestLoader(() => ({ user: "alice" }))
      .loader(({ query }) => {
        observed.push({ ...query });
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
    const { app } = await mountAccount(page, undefined);

    for (const search of [
      "?view=alpha&sort=new",
      "?sort=new&view=alpha&junk=1",
      "?utm_source=x&view=alpha&sort=new",
      "?view=beta&sort=new",
    ]) {
      // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
      await app.handle(new Request(`http://localhost/account${search}`));
    }

    expect(observed).toEqual([
      { sort: "new", view: "alpha" },
      { sort: "new", view: "beta" },
    ]);
  });

  test("keys PPR public shells on declared query values as the schema decodes them", async () => {
    const observed: unknown[] = [];
    const route = defineRoute("/")
      .config({
        mode: "isr",
        query: t.Object({ page: t.Number({ default: 1 }) }),
        revalidate: 60,
      })
      .requestLoader(() => ({ user: "alice" }))
      .loader(({ query }) => {
        observed.push({ ...query });
        return { page: query.page };
      });
    function User({ data }: { data: Promise<string> }) {
      return <strong>{use(data)}</strong>;
    }
    const page = route.page(({ page: current, user }) => (
      <main>
        <h1>{current}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={user} />
        </Suspense>
      </main>
    ));
    const { app } = await mountAccount(page, undefined);

    for (const search of ["?page=02", "?page=2.0", "?page=2", "", "?page=01"]) {
      // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
      await app.handle(new Request(`http://localhost/account${search}`));
    }
    const invalid = await app.handle(new Request("http://localhost/account?page=abc"));

    expect(invalid.status).toBeGreaterThanOrEqual(400);
    expect(observed).toEqual([{ page: 2 }, { page: 1 }]);
  });

  test("PPR routes without a query schema share one shell while requestLoader holes see the raw query", async () => {
    const observed: unknown[] = [];
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60 })
      .requestLoader(({ query }) => ({ user: `ref:${Object.values(query).join()}` }))
      .loader(({ query }) => {
        observed.push({ ...query });
        return { catalog: "Shoes" };
      });
    function User({ data }: { data: Promise<string> }) {
      return <strong>{use(data)}</strong>;
    }
    const page = route.page(({ catalog, user }) => (
      <main>
        <h1>{catalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={user} />
        </Suspense>
      </main>
    ));
    const { app } = await mountAccount(page, undefined);

    const first = await app
      .handle(new Request("http://localhost/account?ref=attacker"))
      .then((response) => response.text());
    const second = await app
      .handle(new Request("http://localhost/account?ref=newsletter"))
      .then((response) => response.text());

    expect(observed).toEqual([{}]);
    expect(first).toContain("ref:attacker");
    expect(second).toContain("ref:newsletter");
    expect(second).not.toContain("attacker");
  });

  test("revalidateTag invalidates a PPR public shell", async () => {
    let catalog = "Shoes";
    let publicCalls = 0;
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
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
    const { app } = await mountAccount(page, undefined);

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
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => {
        publicCalls += 1;
        return { catalog: publicCalls };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const cache = createMemoryPageCache();
    const { app, instance } = await mountAccount(route, cache);

    try {
      await app.handle(new Request("http://localhost/account"));
      await app.handle(new Request("http://localhost/account"));
      expect(publicCalls).toBe(1);
      await cache.invalidate({ kind: "tags", scope: "", tags: ["catalog"] });
      await app.handle(new Request("http://localhost/account"));
    } finally {
      clearPprRouteCache(instance);
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
    const page = defineRoute("/")
      .config({ mode: "isr", revalidate: 3600 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(async () => ({ catalog: (await api.catalog.get()).data }))
      .page(({ catalog }) => <main>{catalog?.title}</main>);
    const cache = createMemoryPageCache();
    const { app, instance } = await mountAccount(page, cache);
    const request = () => app.handle(new Request("http://localhost/account"));
    try {
      await (await request()).text();
      await (await request()).text();
      await (await request()).text();
      expect(reads).toBe(2);
      await cache.invalidate({ kind: "tags", scope: "", tags: [queryTag(identity)] });
      await (await request()).text();
      expect(reads).toBe(3);
    } finally {
      clearPprRouteCache(instance);
      getAutoInvalidateRegistry(instance).unregisterPath("/account");
    }
  });

  /** A deployment runtime cache, as the Vercel handler installs, recording public shell writes. */
  function installDeploymentCache(): string[] {
    const values = new Map<string, unknown>();
    const writes: string[] = [];
    setRuntimeCacheProvider({
      getCache: () => ({
        delete: () => Promise.resolve(),
        expireTag: () => Promise.resolve(),
        get: (key) => Promise.resolve(values.get(key) ?? null),
        set: (key, value) => {
          values.set(key, value);
          writes.push(key);
          return Promise.resolve();
        },
      }),
    });
    return writes;
  }

  function mountQueryAccount(onPublic: () => void, onPrivate: () => void) {
    function User({ data }: { data: Promise<string> }) {
      return <strong>{use(data)}</strong>;
    }
    return mountAccount(
      defineRoute("/")
        .config({
          mode: "isr",
          query: t.Object({ view: t.Optional(t.String()) }),
          revalidate: 60,
        })
        .requestLoader(() => {
          onPrivate();
          return { user: "alice" };
        })
        .loader(({ query }) => {
          onPublic();
          return { view: query.view ?? "" };
        })
        .page(({ user, view }) => (
          <main>
            <h1>{view}</h1>
            <Suspense fallback={<span>Loading</span>}>
              <User data={user} />
            </Suspense>
          </main>
        )),
      undefined
    );
  }

  test("PPR navigation data shares one public shell per canonical query and stays private", async () => {
    const writes = installDeploymentCache();
    let publicCalls = 0;
    let privateCalls = 0;
    const { app } = await mountQueryAccount(
      () => {
        publicCalls += 1;
      },
      () => {
        privateCalls += 1;
      }
    );

    for (const search of ["?view=alpha&junk=1&_furin=data", "?_furin=data&junk=2&view=alpha"]) {
      // biome-ignore lint/performance/noAwaitInLoops: later requests must observe the first cache fill.
      const response = await app.handle(new Request(`http://localhost/account${search}`));
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      await response.text();
    }

    expect(publicCalls).toBe(1);
    expect(privateCalls).toBe(2);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('"isr:/account?view=alpha"');
  });

  test("a platform prerender stores its public shell where navigation data finds it", async () => {
    installDeploymentCache();
    let publicCalls = 0;
    const { app } = await mountQueryAccount(
      () => {
        publicCalls += 1;
      },
      () => undefined
    );

    await app
      .handle(
        markExternalPrerenderRequest(new Request("http://localhost/account?junk=1&view=alpha"))
      )
      .then((response) => response.text());
    await app
      .handle(new Request("http://localhost/account?view=alpha&_furin=data"))
      .then((response) => response.text());

    expect(publicCalls).toBe(1);
  });

  test("a platform prerender records the canonical query its holes resume with", async () => {
    const { app } = await mountQueryAccount(
      () => undefined,
      () => undefined
    );

    const response = await app.handle(
      markExternalPrerenderRequest(new Request("http://localhost/account?view=alpha&utm_source=x"))
    );
    const stateLength = Number(response.headers.get("content-type")?.match(STATE_LENGTH_RE)?.[1]);
    const body = new Uint8Array(await response.arrayBuffer());
    const state = JSON.parse(new TextDecoder().decode(body.subarray(0, stateLength))) as {
      path: string;
    };

    expect(state.path).toBe("/account?view=alpha");
  });

  test("external prerender bypasses shared and local PPR artifacts", async () => {
    let publicCalls = 0;
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => {
        publicCalls += 1;
        return { catalog: publicCalls };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const cache = createMemoryPageCache();
    const { app, instance } = await mountAccount(route, cache);

    try {
      await app.handle(new Request("http://localhost/account"));
      const request = markExternalPrerenderRequest(new Request("http://localhost/account"));
      await app.handle(request);
      expect(publicCalls).toBe(2);
    } finally {
      clearPprRouteCache(instance);
    }
  });

  test("serves stale shared PPR while regeneration runs in the background", async () => {
    const gate = Promise.withResolvers<void>();
    let publicCalls = 0;
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(async () => {
        publicCalls += 1;
        if (publicCalls === 2) {
          await gate.promise;
        }
        return { catalog: publicCalls };
      })
      .page(({ catalog }) => <main>{catalog}</main>);
    const cache = createMemoryPageCache();
    const { app, instance } = await mountAccount(route, cache);
    const identity: PageCacheIdentity = {
      buildId: "build-1",
      key: "isr:/account",
      mode: "ppr",
      path: "/account",
      scope: "",
      tags: [],
    };

    try {
      await app.handle(new Request("http://localhost/account"));
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

      const response = app.handle(new Request("http://localhost/account"));
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
      clearPprRouteCache(instance);
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
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60 })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ catalog: "Fresh catalog" }))
      .page(({ catalog }) => <main>{catalog}</main>);
    const { app, instance } = await mountAccount(route, cache);

    try {
      const response = await app.handle(new Request("http://localhost/account"));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.text()).toContain("Fresh catalog");
    } finally {
      clearPprRouteCache(instance);
    }
  });

  test("streams a rejected request field instead of aborting the PPR response", async () => {
    const route = defineRoute("/")
      .config({ mode: "isr", revalidate: 60 })
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
    const { app } = await mountAccount(page, undefined);

    const html = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(html).toContain("Shoes");
    expect(html).toContain("__FURIN_ROUTE_FRAME_STREAM__");
    expect(html).toContain('\\"key\\":\\"user\\"');
    expect(html).toContain('\\"type\\":\\"defer-reject\\"');
  });
});
