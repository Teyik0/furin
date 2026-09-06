import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { Suspense, use } from "react";
import { defineRootRoute, defineRoute } from "../../../src/furin.ts";
import { revalidateTag } from "../../../src/server/auto-invalidate";
import { getAutoInvalidateRegistry } from "../../../src/server/auto-invalidate/registry.ts";
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
  await Promise.resolve();
});
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

describe("partial prerendering", () => {
  test("cross-instance invalidation removes tags from the cache-owning app", async () => {
    const route = defineRoute()
      .config({ layout: rootTerminal, mode: "isr", revalidate: 60, tags: ["catalog"] })
      .requestLoader(() => ({ user: "alice" }))
      .loader(() => ({ catalog: "Shoes" }))
      .page(({ data }) => <main>{data.catalog}</main>);
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
    const page = route.page(({ data, requestData }) => (
      <main>
        <h1>{data.catalog}</h1>
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
    const page = route.page(({ data, requestData }) => (
      <main>
        <h1>{data.view}</h1>
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
    const page = route.page(({ data, requestData }) => (
      <main>
        <h1>{data.catalog}</h1>
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
    expect(revalidateTag("catalog")).toBe(true);

    const fresh = await app
      .handle(new Request("http://localhost/account"))
      .then((response) => response.text());

    expect(fresh).toContain("Boots");
    expect(publicCalls).toBe(2);
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
    const page = route.page(({ data, requestData }) => (
      <main>
        <h1>{data.catalog}</h1>
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
