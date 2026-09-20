import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { Suspense, use } from "react";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { revalidateTag } from "../../../src/server/auto-invalidate";
import { getAutoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
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
  registerInstance,
  withInstance,
} from "../../../src/server/instance.ts";
import { clearPprRouteCache, invalidatePprRoute } from "../../../src/server/render/ppr-route";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { collectRouteTags } from "../../../src/server/router/discovery.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

(globalThis as typeof globalThis & { __FURIN_SKIP_DOM_RESET?: boolean }).__FURIN_SKIP_DOM_RESET =
  true;

afterEach(async () => {
  clearPprRouteCache();
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
    function User({ data }: { data: Promise<{ user: string }> }) {
      return <strong>{use(data).user}</strong>;
    }
    const resolved = resolveRoute(
      route.page(({ catalog, date, requestData }) => (
        <main>
          {catalog}:{date.toISOString()}
          <Suspense fallback="loading">
            <User data={requestData} />
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
    function User({ data }: { data: Promise<{ user: unknown }> }) {
      return <strong>{String(use(data).user)}</strong>;
    }
    const page = route.page(({ catalog, requestData }) => (
      <main>
        <h1>{catalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={requestData} />
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
    function User({ data }: { data: Promise<{ user: string }> }) {
      return <strong>{use(data).user}</strong>;
    }
    const page = route.page(({ requestData, view }) => (
      <main>
        <h1>{view}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={requestData} />
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
    function User({ data }: { data: Promise<{ user: string }> }) {
      return <strong>{use(data).user}</strong>;
    }
    const page = route.page(({ catalog: loadedCatalog, requestData }) => (
      <main>
        <h1>{loadedCatalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={requestData} />
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

  test("streams a rejected requestData chunk instead of aborting the PPR response", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60 })
      .requestLoader(() => {
        throw new Error("private boom");
      })
      .loader(() => ({ catalog: "Shoes" }));
    function User({ data }: { data: Promise<{ user: unknown }> }) {
      return <strong>{String(use(data).user)}</strong>;
    }
    const page = route.page(({ catalog, requestData }) => (
      <main>
        <h1>{catalog}</h1>
        <Suspense fallback={<span>Loading</span>}>
          <User data={requestData} />
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
    expect(html).toContain('\\"key\\":\\"requestData\\"');
    expect(html).toContain('\\"type\\":\\"defer-reject\\"');
  });
});
