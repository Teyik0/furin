import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AnyElysia, t } from "elysia";
import { createElement } from "react";
import { defer } from "../../../src/client";
import type { HeadOptions } from "../../../src/client.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { findRouteFailure } from "../../../src/shared/route-matches.ts";
import { mountProductionApp, type ProductionPage } from "../../support/production-app.ts";

const DIGEST_RE = /^[0-9a-f]{10}$/;

function routeError(data: { [key: string]: unknown }): unknown {
  const failure = findRouteFailure(data);
  return failure?.status === "error" ? failure.error : undefined;
}

const rootTerminal = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => children);

/** A replacement loader; route builders only see it through `never` casts. */
type TestLoader = (context: never) => unknown;

interface LayoutLoaderContext {
  cookie: { test?: { value: unknown } };
  headers: unknown;
  path: string;
  request: Request;
  set: { headers: { [key: string]: string } };
}

function defaultLayoutLoader({ cookie, headers, path, request, set }: LayoutLoaderContext) {
  set.headers["x-loader-ran"] = "true";
  return {
    cookieValue: cookie.test?.value as string | undefined,
    currentPath: path,
    hasHeaders: Boolean(headers),
    layoutData: "from-layout",
    requestUrl: request.url,
  };
}

/** `/with-loader` under its loader layout, with optional replacement loaders and head. */
function withLoaderPage(
  pageLoader: TestLoader | undefined,
  head: ((context: never) => HeadOptions) | undefined,
  layoutLoader: TestLoader | undefined
): ProductionPage {
  const layout = defineRoute()
    .config({ layout: rootTerminal, mode: "ssr" })
    .loader((layoutLoader ?? defaultLayoutLoader) as never)
    .layout(({ children }) => children);
  const loaded = defineRoute()
    .config({ layout, mode: "ssr" })
    .loader((pageLoader ?? (async () => ({ pageData: "from-page" }))) as never);
  return {
    layout: { route: layout, segment: "with-loader-layout" },
    pattern: "/with-loader",
    route: head ? loaded.head(head as never).page(() => null) : loaded.page(() => null),
  };
}

function deferPage(loader: TestLoader): ProductionPage {
  return {
    pattern: "/defer-page",
    route: defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .loader(loader as never)
      .page(() => null),
  };
}

function numberPage(loader: TestLoader): ProductionPage {
  return {
    pattern: "/number/:id",
    route: defineRoute()
      .config({ layout: rootTerminal, mode: "ssr", params: t.Object({ id: t.Number() }) })
      .loader(loader as never)
      .page(() => null),
  };
}

function basePages(): ProductionPage[] {
  return [
    {
      pattern: "/query-default",
      route: defineRoute()
        .config({
          layout: rootTerminal,
          mode: "ssr",
          query: t.Object({
            city: t.Optional(t.String({ default: "Paris" })),
          }),
        })
        .page(() => null),
    },
    {
      pattern: "/query-types",
      route: defineRoute()
        .config({
          layout: rootTerminal,
          mode: "ssr",
          query: t.Object({
            active: t.Boolean(),
            filter: t.Optional(t.Object({ category: t.String() })),
            page: t.Number(),
            tags: t.Optional(t.Array(t.String())),
          }),
        })
        .loader(({ query }) => ({ queryFromLoader: query }))
        .page(() => null),
    },
    withLoaderPage(undefined, undefined, undefined),
    deferPage(() =>
      defer({
        stats: Promise.resolve(42),
        title: "deferred page",
      })
    ),
    {
      pattern: "/ssr-page",
      route: defineRoute()
        .config({ layout: rootTerminal, mode: "ssr" })
        .page(() => null),
    },
    {
      pattern: "/dynamic/:id",
      route: defineRoute()
        .config({ layout: rootTerminal, mode: "ssr", params: t.Object({ id: t.String() }) })
        .loader(() => ({ pageData: "from-dynamic" }))
        .page(() => null),
    },
    numberPage(({ params }: { params: { id: number } }) => ({ paramsFromLoader: params })),
    {
      pattern: "/dynamic/specific",
      route: defineRoute()
        .config({ layout: rootTerminal, mode: "ssr" })
        .loader(() => ({ pageData: "from-static-specific" }))
        .page(() => null),
    },
    {
      pattern: "/account",
      route: defineRoute()
        .config({ layout: rootTerminal, mode: "ssr" })
        .loader(({ redirect }) => {
          throw redirect("?tab=billing");
        })
        .page(() => null),
    },
    {
      pattern: "/dynamic-defer/:slug",
      route: defineRoute()
        .config({ layout: rootTerminal, mode: "ssr", params: t.Object({ slug: t.String() }) })
        .loader(({ params }) =>
          defer({
            post: Promise.resolve({ title: `Post for ${params.slug}` }),
            slug: params.slug,
          })
        )
        .page(() => null),
    },
  ];
}

/** Mounts the base pages through `furin()`, replacing those named in `overrides`. */
async function createDataTestApp(overrides: readonly ProductionPage[]): Promise<AnyElysia> {
  const pages = basePages().map(
    (page) => overrides.find((override) => override.pattern === page.pattern) ?? page
  );
  const { app } = await mountProductionApp({ buildId: "", pages, root: rootTerminal });
  return app;
}

async function mountPage(page: ProductionPage): Promise<AnyElysia> {
  const { app } = await mountProductionApp({ buildId: "", pages: [page], root: rootTerminal });
  return app;
}

const originalDevMode = IS_DEV;

beforeEach(() => {
  __setDevMode(false);
});

afterEach(() => {
  __resetCompileContext();
  __setDevMode(originalDevMode);
});

describe("SPA navigation data (?_furin=data)", () => {
  test("resolves query defaults without emitting a redirect sentinel", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(new Request("http://localhost/query-default?_furin=data"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.__furinRedirect).toBeUndefined();
    expect(syncData.query).toEqual({ city: "Paris" });
  });

  test("resolves search-only redirects against the logical route URL", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(new Request("http://localhost/account?_furin=data"));

    expect(res.status).toBe(200);

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );

    expect(syncData.__furinRedirect).toBe("/account?tab=billing");
  });

  test("passes schema-coerced query values to loaders during SPA navigation", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(
      new Request(
        "http://localhost/query-types?page=2&active=true&tags=react&tags=furin&_furin=data"
      )
    );

    expect(res.status).toBe(200);

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );

    expect(syncData.query).toEqual({ active: true, page: 2, tags: ["react", "furin"] });
    expect(syncData.queryFromLoader).toEqual({
      active: true,
      page: 2,
      tags: ["react", "furin"],
    });
  });

  test("passes JSON object query values to loaders during SPA navigation", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(
      new Request(
        `http://localhost/query-types?page=2&active=true&filter=${encodeURIComponent(
          '{"category":"framework"}'
        )}&_furin=data`
      )
    );

    expect(res.status).toBe(200);

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );

    expect(syncData.query).toMatchObject({
      filter: { category: "framework" },
    });
    expect(syncData.queryFromLoader).toMatchObject({
      filter: { category: "framework" },
    });
  });

  test("rejects invalid schema query values before running loaders during SPA navigation", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(
      new Request("http://localhost/query-types?page=nope&active=true&_furin=data")
    );

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    // The page's own Elysia route validates the query before any loader runs.
    expect(await res.json()).toMatchObject({ on: "query", status: 422 });
  });

  test("answers an unknown path with an empty uncacheable 404", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(new Request("http://localhost/route-inexistante?_furin=data"));

    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.text()).toBe("");
  });

  test("returns NDJSON for a route with a synchronous loader", async () => {
    const app = await createDataTestApp([]);
    const res = await app.handle(new Request("http://localhost/with-loader?_furin=data"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.pageData).toBe("from-page");
    expect(Object.keys(deferredPromises)).toHaveLength(0);
  });

  test("returns route frames with Promise for a route using defer()", async () => {
    const app = await createDataTestApp([]);
    const res = await app.handle(new Request("http://localhost/defer-page?_furin=data"));

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-furin-route");

    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await deferredPromises.stats;
    expect(resolvedStats).toBe(42);
  });

  test("streams request fields for an ISR route during SPA navigation", async () => {
    // The public part of a PPR route is a prerendered shell: it needs a
    // complete root HTML document.
    const documentRoot = defineRootRoute()
      .config({ mode: "ssr" })
      .layout(({ children }) =>
        createElement(
          "html",
          { lang: "en" },
          createElement("head", null, createElement(HeadContent)),
          createElement("body", null, children, createElement(Scripts))
        )
      );
    const routeDefinition = defineRoute()
      .config({ layout: documentRoot, mode: "isr", revalidate: 60 })
      .requestLoader(({ cookies }) => ({ user: cookies.get("session") }))
      .loader(() => ({ catalog: "Shoes" }))
      .page(() => null);
    const { app } = await mountProductionApp({
      buildId: "",
      pages: [{ pattern: "/ppr-account", requestKeys: ["user"], route: routeDefinition }],
      root: documentRoot,
    });

    const res = await app.handle(
      new Request("http://localhost/ppr-account?_furin=data", {
        headers: { cookie: "session=alice" },
      })
    );

    expect(res.status).toBe(200);
    const { deferredPromises, syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.catalog).toBe("Shoes");
    expect(deferredPromises.user).toBeInstanceOf(Promise);
    expect(await deferredPromises.user).toBe("alice");
  });

  test("forwards request headers to loaders reading request.headers", async () => {
    const routeDefinition = defineRoute()
      .config({ layout: rootTerminal, mode: "ssr" })
      .loader(({ request }) => ({
        authHeader: request.headers.get("authorization"),
        cookieHeader: request.headers.get("cookie"),
      }))
      .page(() => null);
    const app = await mountPage({ pattern: "/protected", route: routeDefinition });

    const res = await app.handle(
      new Request("http://localhost/protected?_furin=data", {
        headers: { authorization: "Bearer token-123", cookie: "session=alice" },
      })
    );

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.cookieHeader).toBe("session=alice");
    expect(syncData.authHeader).toBe("Bearer token-123");
  });

  test("returns the response before deferred Promises have resolved", async () => {
    let resolveStats: ((value: number) => void) | undefined;
    const stats = new Promise<number>((resolve) => {
      resolveStats = resolve;
    });
    const app = await createDataTestApp([
      deferPage(() =>
        defer({
          stats,
          title: "deferred page",
        })
      ),
    ]);
    const responsePromise = app.handle(new Request("http://localhost/defer-page?_furin=data"));

    const res = await Promise.race([
      responsePromise,
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    if (res === "blocked") {
      resolveStats?.(42);
      throw new Error("Data endpoint waited for a deferred Promise before returning a Response.");
    }
    expect(res.status).toBe(200);

    if (resolveStats === undefined) {
      throw new Error("Deferred stats resolver was not initialized.");
    }
    resolveStats(42);
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.title).toBe("deferred page");
    expect(deferredPromises.stats).toBeInstanceOf(Promise);
    expect(await deferredPromises.stats).toBe(42);
  });

  test("emits the resolved page head for SPA navigation", async () => {
    // During SPA navigation the client fetches `?_furin=data` (NDJSON) — head()
    // never runs in the browser, so the server must resolve the page title
    // and ship it as the reserved __furinTitle field. Without this, the client
    // has to rely on a loader returning a magic `title` field.
    const app = await createDataTestApp([
      withLoaderPage(
        undefined,
        ({ pageData }: { pageData: string }) => ({ meta: [{ title: `Page: ${pageData}` }] }),
        undefined
      ),
    ]);
    const res = await app.handle(new Request("http://localhost/with-loader?_furin=data"));

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.__furinTitle).toBe("Page: from-page");
    expect(syncData.__furinHead).toEqual({
      meta: [{ title: "Page: from-page" }],
    });
  });

  test("does not let oversized head metadata break SPA navigation", async () => {
    const app = await createDataTestApp([
      withLoaderPage(
        undefined,
        () => ({
          meta: [{ title: "Large head" }],
          styles: [{ children: "x".repeat(1024 * 1024) }],
        }),
        undefined
      ),
    ]);

    const response = await app.handle(new Request("http://localhost/with-loader?_furin=data"));
    const { syncData } = await parseDeferredNdjson(
      response.body ??
        new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      undefined
    );

    expect(response.status).toBe(200);
    expect(syncData.__furinTitle).toBe("Large head");
    expect(syncData.__furinHead).toBeUndefined();
  });

  test("does not set __furinStatus for a route without a loader", async () => {
    // SSR route without loader doesn't trigger notFound.
    // We test the ssr-page which has no loader — data should be empty.
    const app = await createDataTestApp([]);
    const res = await app.handle(new Request("http://localhost/ssr-page?_furin=data"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    // No special fields — just empty data
    expect(syncData.__furinStatus).toBeUndefined();
  });

  test("returns params in NDJSON for dynamic routes", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(new Request("http://localhost/dynamic/42?_furin=data"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.params).toEqual({ id: "42" });
    expect(syncData.path).toBe("/dynamic/42");
  });

  test("passes schema-coerced params to loaders during SPA navigation", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(new Request("http://localhost/number/42?_furin=data"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.params).toEqual({ id: 42 });
    expect(syncData.paramsFromLoader).toEqual({ id: 42 });
  });

  test("rejects invalid schema params before running loaders during SPA navigation", async () => {
    let loaderRuns = 0;
    const app = await createDataTestApp([
      numberPage(() => {
        loaderRuns += 1;
        return { pageData: "should-not-run" };
      }),
    ]);

    const res = await app.handle(new Request("http://localhost/number/nope?_furin=data"));

    expect(res.status).toBe(422);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    // The page's own Elysia route validates params before any loader runs.
    expect(await res.json()).toMatchObject({ on: "params", status: 422 });
    expect(loaderRuns).toBe(0);
  });

  test("prefers a static route over a dynamic sibling that also matches", async () => {
    // `/dynamic/specific` (static) and `/dynamic/:id` (dynamic) both match the
    // path `/dynamic/specific`. The endpoint must pick the static route — the
    // dynamic one would otherwise shadow it (its dir `[id]` is scanned first).
    const app = await createDataTestApp([]);

    const res = await app.handle(new Request("http://localhost/dynamic/specific?_furin=data"));

    expect(res.status).toBe(200);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.pageData).toBe("from-static-specific");
    // The dynamic route would have produced a `params.id` — the static one has none.
    expect(syncData.params).toEqual({});
  });

  test("layout loader returning defer() streams its deferred field through the NDJSON endpoint", async () => {
    const app = await createDataTestApp([
      withLoaderPage(undefined, undefined, () =>
        defer({
          asyncWidget: Promise.resolve(["item-a", "item-b"]),
          layoutData: "from-layout-defer",
        })
      ),
    ]);
    const res = await app.handle(new Request("http://localhost/with-loader?_furin=data"));

    expect(res.status).toBe(200);
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    expect(syncData.layoutData).toBe("from-layout-defer");
    expect(deferredPromises.asyncWidget).toBeInstanceOf(Promise);
    expect(await deferredPromises.asyncWidget).toEqual(["item-a", "item-b"]);
  });

  test("layout defer + page defer → both deferred Promises arrive as separate route frames", async () => {
    const app = await createDataTestApp([
      withLoaderPage(
        () =>
          defer({
            asyncStats: Promise.resolve(99),
            pageData: "from-page",
          }),
        undefined,
        () =>
          defer({
            asyncWidget: Promise.resolve("widget-ok"),
            layoutData: "from-layout",
          })
      ),
    ]);
    const res = await app.handle(new Request("http://localhost/with-loader?_furin=data"));

    expect(res.status).toBe(200);
    const text = await new Response(res.body).text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Line 0 is the initial sync payload. Subsequent lines are resolution frames
    // — one per deferred field, regardless of which loader produced it.
    const resolutionKeys = lines
      .slice(1)
      .map((line) => (JSON.parse(line) as { frame: { key: string } }).frame.key);
    expect(resolutionKeys.sort()).toEqual(["asyncStats", "asyncWidget"]);
  });

  test("emits chunks in resolution order, not insertion order", async () => {
    // 'slow' is inserted FIRST in defer() but resolves LAST. 'fast' is inserted
    // SECOND but resolves FIRST. The on-the-wire stream MUST emit the fast key
    // first — otherwise streaming is cosmetic and a fast field is held hostage
    // by a slow sibling. This is the whole reason defer() exists.
    let resolveFast: ((value: string) => void) | undefined;
    let resolveSlow: ((value: string) => void) | undefined;
    const fast = new Promise<string>((resolve) => {
      resolveFast = resolve;
    });
    const slow = new Promise<string>((resolve) => {
      resolveSlow = resolve;
    });
    const app = await createDataTestApp([
      deferPage(() =>
        defer({
          fast,
          slow,
          title: "deferred page",
        })
      ),
    ]);
    const res = await app.handle(new Request("http://localhost/defer-page?_furin=data"));

    const textPromise = new Response(res.body).text();
    if (resolveFast === undefined || resolveSlow === undefined) {
      throw new Error("Deferred order resolvers were not initialized.");
    }
    resolveFast("fast-value");
    await Promise.resolve();
    resolveSlow("slow-value");
    const text = await textPromise;
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    // Line 0 is the initial sync payload, lines 1+ are resolution frames.
    const resolutionKeys = lines
      .slice(1)
      .map((line) => (JSON.parse(line) as { frame: { key: string } }).frame.key);

    expect(resolutionKeys).toEqual(["fast", "slow"]);
  });

  test("defer() on a dynamic route: params are in syncData and deferred Promises stream", async () => {
    const app = await createDataTestApp([]);

    const res = await app.handle(
      new Request("http://localhost/dynamic-defer/hello-world?_furin=data")
    );

    expect(res.status).toBe(200);
    const { syncData, deferredPromises } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    // Sync scalar fields (including route ctx + the `slug` field returned by
    // the page loader) are immediately available.
    expect(syncData.params).toEqual({ slug: "hello-world" });
    expect(syncData.path).toBe("/dynamic-defer/hello-world");
    expect(syncData.slug).toBe("hello-world");
    // The deferred field arrives as a Promise that settles via the NDJSON
    // resolution chunk.
    expect(deferredPromises.post).toBeInstanceOf(Promise);
    expect(await deferredPromises.post).toEqual({ title: "Post for hello-world" });
  });

  // ── Slice 3 — SPA error sentinel ───────────────────────────────────────────
  test("loader throwing Response(403) returns HTTP 403 with an error route match", async () => {
    const app = await createDataTestApp([
      withLoaderPage(
        () => {
          throw new Response("Forbidden", { status: 403 });
        },
        undefined,
        undefined
      ),
    ]);
    const res = await app.handle(
      new Request("http://localhost/with-loader?tab=details&_furin=data")
    );

    // The HTTP status of the data response matches the loader's Response.status —
    // browsers and monitoring see the right code.
    expect(res.status).toBe(403);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");

    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    const furinError = routeError(syncData) as
      | { status: number; message: string; digest: string }
      | undefined;
    expect(furinError).toBeDefined();
    expect(furinError?.status).toBe(403);
    expect(furinError?.message).toBe("Forbidden");
    // Digest is a 10-hex-char string correlating with server logs.
    expect(furinError?.digest).toMatch(DIGEST_RE);
    expect(syncData.params).toEqual({});
    expect(syncData.path).toBe("/with-loader");
    expect(syncData.query).toEqual({ tab: "details" });
  });

  test("loader throwing plain Error returns HTTP 500 with an error route match", async () => {
    const app = await createDataTestApp([
      withLoaderPage(
        () => {
          throw new Error("kaboom");
        },
        undefined,
        undefined
      ),
    ]);
    const res = await app.handle(new Request("http://localhost/with-loader?_furin=data"));

    expect(res.status).toBe(500);
    const { syncData } = await parseDeferredNdjson(
      res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      undefined
    );
    const furinError = routeError(syncData) as
      | { status: number; message: string; digest: string }
      | undefined;
    expect(furinError).toBeDefined();
    expect(furinError?.status).toBe(500);
    // Original error message MUST NOT leak — generic public message instead.
    expect(furinError?.message).toBe("Something went wrong");
    expect(furinError?.message).not.toContain("kaboom");
    expect(furinError?.digest).toMatch(DIGEST_RE);
  });
});
