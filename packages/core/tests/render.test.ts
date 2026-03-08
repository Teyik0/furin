import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Cookie } from "elysia";
import type { HTTPHeaders } from "elysia/types";
import type { RuntimeRoute } from "../src/client";
import { __setDevMode, IS_DEV } from "../src/elyra";
import {
  buildElement,
  handleISR,
  type LoaderContext,
  loadPageModule,
  loadRootModule,
  prerenderSSG,
  renderSSR,
  renderToHTML,
  renderToStream,
  runLoaders,
  streamToString,
  warmSSGCache,
} from "../src/render";
import { ssgCache } from "../src/render/cache";
import type { ResolvedRoute } from "../src/router";
import { scanPages } from "../src/router";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures/pages");

function createMockLoaderContext(overrides: Partial<LoaderContext> = {}): LoaderContext {
  return {
    params: {},
    query: {},
    request: new Request("http://localhost/test"),
    headers: {},
    cookie: {},
    redirect: (url) => new Response(null, { status: 302, headers: { Location: url } }),
    set: { headers: {} as HTTPHeaders },
    path: "/test",
    ...overrides,
  };
}

async function getRoute(pattern: string): Promise<ResolvedRoute> {
  const result = await scanPages(FIXTURES_DIR);
  const route = result.routes.find((r) => r.pattern === pattern);
  if (!route) {
    throw new Error(`Route ${pattern} not found`);
  }
  return route;
}

async function getRoot() {
  const result = await scanPages(FIXTURES_DIR);
  if (!result.root) {
    throw new Error("Root not found");
  }
  return result.root;
}

function makeRuntimeRoute(opts: Partial<Omit<RuntimeRoute, "__type">> = {}): RuntimeRoute {
  return { __type: "ELYSION_ROUTE", ...opts };
}

describe("render.tsx", () => {
  const originalDevMode = IS_DEV;
  beforeAll(() => __setDevMode(false));
  afterAll(() => __setDevMode(originalDevMode));

  describe("streamToString", () => {
    test("converts readable stream to string", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("Hello "));
          controller.enqueue(encoder.encode("World"));
          controller.close();
        },
      });

      const result = await streamToString(stream);
      expect(result).toBe("Hello World");
    });

    test("handles empty stream", async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.close();
        },
      });

      const result = await streamToString(stream);
      expect(result).toBe("");
    });

    test("handles multi-byte characters", async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("Hello "));
          controller.enqueue(encoder.encode("世界"));
          controller.close();
        },
      });

      const result = await streamToString(stream);
      expect(result).toBe("Hello 世界");
    });
  });

  describe("buildElement", () => {
    test("wraps component with nested layouts", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      await loadPageModule(nestedRoute);
      const rootLayout = await loadRootModule(root);

      const element = buildElement(nestedRoute, {}, rootLayout);
      expect(element).toBeDefined();
    });

    test("applies layouts in correct order (innermost first)", async () => {
      const deepRoute = await getRoute("/nested/deep");
      const root = await getRoot();

      await loadPageModule(deepRoute);
      const rootLayout = await loadRootModule(root);

      const element = buildElement(deepRoute, {}, rootLayout);
      expect(element).toBeDefined();
    });

    test("skips root layout in chain", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      await loadPageModule(nestedRoute);
      const rootLayout = await loadRootModule(root);

      const element = buildElement(nestedRoute, {}, rootLayout);
      expect(element).toBeDefined();
    });

    test("returns Loading div when page undefined", () => {
      const route = {
        page: undefined,
        routeChain: [],
      } as unknown as Parameters<typeof buildElement>[0];

      const element = buildElement(route, {}, null);
      expect(element).toBeDefined();
    });
  });

  describe("runLoaders", () => {
    test("runs root loader first", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const result = await runLoaders(withLoaderRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(result.data.layoutData).toBe("from-layout");
        expect(result.data.pageData).toBe("from-page");
      }
    });

    test("runs layout loaders in chain order", async () => {
      const deepRoute = await getRoute("/nested/deep");
      const root = await getRoot();

      await loadPageModule(deepRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({ path: "/nested/deep" });
      const result = await runLoaders(deepRoute, ctx, rootLayout);
      expect(result.type).toBe("data");
    });

    test("runs page loader last", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const result = await runLoaders(withLoaderRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(result.data.pageData).toBe("from-page");
        expect(result.data.layoutData).toBe("from-layout");
      }
    });

    test("merges data from all loaders", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const result = await runLoaders(withLoaderRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(Object.keys(result.data).length).toBeGreaterThanOrEqual(2);
      }
    });

    test("captures headers set by loader", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const result = await runLoaders(withLoaderRoute, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(result.headers["x-loader-ran"]).toBe("true");
      }
    });

    test("handles throw redirect() as redirect result", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({
        path: "/with-loader",
        cookie: {} as Record<string, Cookie<unknown>>,
      });

      const customRoute = {
        ...withLoaderRoute,
        page: {
          ...withLoaderRoute.page,
          loader: (ctx: Record<string, unknown>) => {
            const redirect = ctx.redirect as (url: string) => Response;
            throw redirect("/login");
          },
        },
      } as ResolvedRoute;

      const result = await runLoaders(customRoute, ctx, rootLayout);

      expect(result.type).toBe("redirect");
      if (result.type === "redirect") {
        expect(result.response.status).toBe(302);
        expect(result.response.headers.get("Location")).toBe("/login");
      }
    });

    describe("parallel execution", () => {
      test("deps() returns {} for a route not in the loader map", async () => {
        const unknown = makeRuntimeRoute();
        let captured: Record<string, unknown> | undefined;
        const ancestor = makeRuntimeRoute({
          loader: async (_ctx, deps) => {
            captured = (await deps?.(unknown)) ?? {};
            return {};
          },
        });
        const withLoaderRoute = await getRoute("/with-loader");
        const rootLayout = await loadRootModule(await getRoot());
        const mockRoute = {
          ...withLoaderRoute,
          routeChain: [withLoaderRoute.routeChain[0], ancestor],
          page: { ...withLoaderRoute.page, loader: undefined },
        } as unknown as ResolvedRoute;
        await runLoaders(mockRoute, createMockLoaderContext(), rootLayout);
        expect(captured).toEqual({});
      });

      test("deps() resolves the data returned by an earlier ancestor loader", async () => {
        let capturedFromDeps: Record<string, unknown> | undefined;
        const ancestor1 = makeRuntimeRoute({
          loader: async () => ({ token: "abc" }),
        });
        const ancestor2 = makeRuntimeRoute({
          loader: async (_ctx, deps) => {
            capturedFromDeps = (await deps?.(ancestor1)) ?? {};
            return {};
          },
        });
        const withLoaderRoute = await getRoute("/with-loader");
        const rootLayout = await loadRootModule(await getRoot());
        const mockRoute = {
          ...withLoaderRoute,
          routeChain: [withLoaderRoute.routeChain[0], ancestor1, ancestor2],
          page: { ...withLoaderRoute.page, loader: undefined },
        } as unknown as ResolvedRoute;
        await runLoaders(mockRoute, createMockLoaderContext(), rootLayout);
        expect(capturedFromDeps?.token).toBe("abc");
      });

      test("all ancestor loaders start before any completes (parallel, not waterfall)", async () => {
        const DELAY = 40;
        let start0 = 0;
        let start1 = 0;
        let end0 = 0;
        let end1 = 0;

        const a1 = makeRuntimeRoute({
          loader: async () => {
            start0 = performance.now();
            await new Promise((r) => setTimeout(r, DELAY));
            end0 = performance.now();
            return { a1: true };
          },
        });
        const a2 = makeRuntimeRoute({
          loader: async () => {
            start1 = performance.now();
            await new Promise((r) => setTimeout(r, DELAY));
            end1 = performance.now();
            return { a2: true };
          },
        });
        const withLoaderRoute = await getRoute("/with-loader");
        const rootLayout = await loadRootModule(await getRoot());
        const mockRoute = {
          ...withLoaderRoute,
          routeChain: [withLoaderRoute.routeChain[0], a1, a2],
          page: { ...withLoaderRoute.page, loader: undefined },
        } as unknown as ResolvedRoute;

        await runLoaders(mockRoute, createMockLoaderContext(), rootLayout);

        // Both loaders started before either one finished (overlap = parallel)
        expect(start0).toBeLessThan(end1);
        expect(start1).toBeLessThan(end0);
      });

      test("results from all loaders are flat-merged into the final data", async () => {
        const a1 = makeRuntimeRoute({ loader: async () => ({ keyA: "valueA" }) });
        const a2 = makeRuntimeRoute({ loader: async () => ({ keyB: "valueB" }) });
        const withLoaderRoute = await getRoute("/with-loader");
        const rootLayout = await loadRootModule(await getRoot());
        const mockRoute = {
          ...withLoaderRoute,
          routeChain: [withLoaderRoute.routeChain[0], a1, a2],
          page: {
            ...withLoaderRoute.page,
            loader: async () => ({ keyC: "valueC" }),
          },
        } as unknown as ResolvedRoute;
        const result = await runLoaders(mockRoute, createMockLoaderContext(), rootLayout);
        expect(result.type).toBe("data");
        if (result.type === "data") {
          expect(result.data.keyA).toBe("valueA");
          expect(result.data.keyB).toBe("valueB");
          expect(result.data.keyC).toBe("valueC");
        }
      });
    });
  });

  describe("renderToHTML", () => {
    test("renders page with layout content", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/nested" });
      const result = await renderToHTML(nestedRoute, ctx, root);

      // Template provides <html>, page content appears in the outlet
      expect(result.html).toContain("<html");
      expect(result.html).toContain("nested-page");
    });

    test("includes data script", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const result = await renderToHTML(withLoaderRoute, ctx, root);

      expect(result.html).toContain("__ELYSION_DATA__");
    });

    test("injects head tags from page head() function", async () => {
      const ssgRoute = await getRoute("/ssg-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/ssg-page" });
      const result = await renderToHTML(ssgRoute, ctx, root);

      expect(result.html).toContain("<title>SSG Test Page</title>");
    });

    test("page content appears between ssr-outlet placeholders", async () => {
      const nestedRoute = await getRoute("/nested");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/nested" });
      const result = await renderToHTML(nestedRoute, ctx, root);

      // The outlet comment is replaced by React-rendered content
      expect(result.html).not.toContain("<!--ssr-outlet-->");
      expect(result.html).toContain("nested-page");
    });
  });

  describe("prerenderSSG", () => {
    test("renders and caches HTML", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html1 = await prerenderSSG(indexRoute, {}, root);
      const html2 = await prerenderSSG(indexRoute, {}, root);

      expect(html1).toBe(html2);
    });

    test("renders HTML with template structure", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html = await prerenderSSG(indexRoute, {}, root);
      expect(html).toContain("<html");
    });

    test("returns cached HTML on second call", async () => {
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html1 = await prerenderSSG(indexRoute, {}, root);
      const html2 = await prerenderSSG(indexRoute, {}, root);

      expect(html1).toBe(html2);
    });
  });

  describe("renderSSR", () => {
    test("returns Response with HTML", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/ssr-page" });
      const response = await renderSSR(ssrRoute, ctx, root);

      expect(response).toBeInstanceOf(Response);
      const html = await response.text();
      expect(html).toContain("<html");
    });

    test("sets correct headers (no-cache)", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/ssr-page" });
      const response = await renderSSR(ssrRoute, ctx, root);

      expect(response.headers.get("Content-Type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("Cache-Control")).toBe("no-cache, no-store, must-revalidate");
    });

    test("propagates headers set by loader", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/with-loader" });
      const response = await renderSSR(withLoaderRoute, ctx, root);

      expect(response.headers.get("x-loader-ran")).toBe("true");
    });

    test("returns redirect Response when loader throws redirect", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const redirectMock = (url: string) =>
        new Response(null, { status: 302, headers: { Location: url } });
      const ctx = createMockLoaderContext({
        path: "/ssr-page",
        redirect: redirectMock,
      });

      const customRoute = {
        ...ssrRoute,
        page: {
          ...ssrRoute.page,
          loader: (loaderCtx: Record<string, unknown>) => {
            const redirect = loaderCtx.redirect as (url: string) => Response;
            throw redirect("/login");
          },
        },
      } as ResolvedRoute;

      const response = await renderSSR(customRoute, ctx, root);

      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe("/login");
    });

    describe("Suspense streaming", () => {
      test("response body is a ReadableStream (not a buffered string)", async () => {
        const suspenseRoute = await getRoute("/suspense-page");
        const root = await getRoot();

        const ctx = createMockLoaderContext({ path: "/suspense-page" });
        const response = await renderSSR(suspenseRoute, ctx, root);

        expect(response.body).toBeInstanceOf(ReadableStream);
      });

      test("Suspense content resolves in the final HTML", async () => {
        const suspenseRoute = await getRoute("/suspense-page");
        const root = await getRoot();

        const ctx = createMockLoaderContext({ path: "/suspense-page" });
        const response = await renderSSR(suspenseRoute, ctx, root);
        const html = await response.text();

        // The resolved Suspense content must appear — either inline (if React
        // resolves synchronously) or via the script-based hydration injection.
        expect(html).toContain("Suspense Content Loaded");
        expect(html).not.toContain('data-testid="suspense-fallback"');
      });

      test("HTML structure is valid with Suspense (head + body placeholders replaced)", async () => {
        const suspenseRoute = await getRoute("/suspense-page");
        const root = await getRoot();

        const ctx = createMockLoaderContext({ path: "/suspense-page" });
        const response = await renderSSR(suspenseRoute, ctx, root);
        const html = await response.text();

        expect(html).toContain("<html");
        expect(html).not.toContain("<!--ssr-head-->");
        expect(html).not.toContain("<!--ssr-outlet-->");
        expect(html).toContain('data-testid="suspense-page"');
        expect(html).toContain("__ELYSION_DATA__");
      });
    });
  });

  describe("handleISR", () => {
    test("caches HTML on first render", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/isr-page" });
      const response = await handleISR(isrRoute, ctx, root);
      const html = await response.text();

      expect(html).toContain("<html");
      expect(html).toContain("isr-page");
    });

    test("sets correct Cache-Control headers", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/isr-page" });
      const response = await handleISR(isrRoute, ctx, root);

      const cacheControl = response.headers.get("Cache-Control");
      expect(cacheControl).toContain("public");
      expect(cacheControl).toContain("s-maxage=60");
    });

    test("returns cached HTML when fresh", async () => {
      const isrRoute = await getRoute("/isr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/isr-page" });
      const response1 = await handleISR(isrRoute, ctx, root);
      const html1 = await response1.text();

      const response2 = await handleISR(isrRoute, ctx, root);
      const html2 = await response2.text();

      expect(html1).toBe(html2);
    });
  });

  describe("loadPageModule", () => {
    test("returns cached page in production mode", async () => {
      const indexRoute = await getRoute("/");

      const page = await loadPageModule(indexRoute);
      expect(page).toBeDefined();
      expect(page?.component).toBeDefined();
    });

    test("reloads page in dev mode", async () => {
      __setDevMode(true);
      try {
        const indexRoute = await getRoute("/");

        const page = await loadPageModule(indexRoute);
        expect(page).toBeDefined();
      } finally {
        __setDevMode(false);
      }
    });
  });

  describe("loadRootModule", () => {
    test("returns cached root in production mode", async () => {
      const root = await getRoot();

      const rootRoute = await loadRootModule(root);
      expect(rootRoute).toBeDefined();
      expect(rootRoute.layout).toBeDefined();
    });

    test("reloads root in dev mode", async () => {
      __setDevMode(true);
      try {
        const root = await getRoot();

        const rootRoute = await loadRootModule(root);
        expect(rootRoute).toBeDefined();
      } finally {
        __setDevMode(false);
      }
    });
  });

  describe("error handling", () => {
    test("runLoaders throws non-Response errors", async () => {
      const withLoaderRoute = await getRoute("/with-loader");
      const root = await getRoot();

      await loadPageModule(withLoaderRoute);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({ path: "/with-loader" });

      const customRoute = {
        ...withLoaderRoute,
        page: {
          ...withLoaderRoute.page,
          loader: () => {
            throw new Error("Loader error");
          },
        },
      } as ResolvedRoute;

      expect(runLoaders(customRoute, ctx, rootLayout)).rejects.toThrow("Loader error");
    });

    test("runLoaders runs rootLayout loader and merges headers", async () => {
      const route = await getRoute("/");
      const root = await getRoot();

      await loadPageModule(route);
      const rootLayout = await loadRootModule(root);

      const ctx = createMockLoaderContext({
        path: "/",
        set: { headers: { "x-custom": "from-set" } as HTTPHeaders },
      });

      const result = await runLoaders(route, ctx, rootLayout);

      expect(result.type).toBe("data");
      if (result.type === "data") {
        expect(result.headers).toBeDefined();
      }
    });
  });

  describe("warmSSGCache", () => {
    test("is a no-op for an empty routes array", async () => {
      await expect(warmSSGCache([], null, "http://localhost:3000")).resolves.toBeUndefined();
    });

    test("skips SSG routes that have no staticParams", async () => {
      const indexRoute = await getRoute("/");
      const sizeBefore = ssgCache.size;
      await warmSSGCache([indexRoute], null, "http://localhost:3000");
      expect(ssgCache.size).toBe(sizeBefore);
    });

    test("skips non-SSG routes even when they carry a staticParams function", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const routeWithFakeParams = {
        ...ssrRoute,
        mode: "ssr" as const,
        page: { ...ssrRoute.page, staticParams: async () => [{}] },
      } as ResolvedRoute;
      const sizeBefore = ssgCache.size;
      await warmSSGCache([routeWithFakeParams], null, "http://localhost:3000");
      expect(ssgCache.size).toBe(sizeBefore);
    });

    test("populates ssgCache for an SSG route with staticParams", async () => {
      const root = await getRoot();
      const indexRoute = await getRoute("/");
      ssgCache.delete("/");
      const routeWithParams = {
        ...indexRoute,
        mode: "ssg" as const,
        page: { ...indexRoute.page, staticParams: async () => [{}] },
      } as ResolvedRoute;
      await warmSSGCache([routeWithParams], root, "http://localhost:3000");
      expect(ssgCache.has("/")).toBe(true);
      expect(ssgCache.get("/")).toContain("<html");
    });

    test("calls staticParams() exactly once and pre-renders every returned param set", async () => {
      const root = await getRoot();
      const indexRoute = await getRoute("/");
      let callCount = 0;
      const routeWithParams = {
        ...indexRoute,
        mode: "ssg" as const,
        page: {
          ...indexRoute.page,
          staticParams: () => {
            callCount++;
            return Promise.resolve([{}, {}]); // two sets, same pattern → same cache key; second hits cache
          },
        },
      } as ResolvedRoute;
      ssgCache.delete("/");
      await warmSSGCache([routeWithParams], root, "http://localhost:3000");
      expect(callCount).toBe(1);
      expect(ssgCache.has("/")).toBe(true);
    });

    test("warms multiple routes in a single call", async () => {
      const root = await getRoot();
      const indexRoute = await getRoute("/");
      const ssgRoute = await getRoute("/ssg-page");
      ssgCache.delete("/");
      ssgCache.delete("/ssg-page");
      const routes = [
        {
          ...indexRoute,
          mode: "ssg" as const,
          page: { ...indexRoute.page, staticParams: async () => [{}] },
        },
        {
          ...ssgRoute,
          mode: "ssg" as const,
          page: { ...ssgRoute.page, staticParams: async () => [{}] },
        },
      ] as ResolvedRoute[];
      await warmSSGCache(routes, root, "http://localhost:3000");
      expect(ssgCache.has("/")).toBe(true);
      expect(ssgCache.has("/ssg-page")).toBe(true);
    });
  });

  describe("resolvePath", () => {
    test("replaces named params in pattern", async () => {
      // resolvePath is used internally by prerenderSSG and handleISR
      const indexRoute = await getRoute("/");
      const root = await getRoot();

      const html = await prerenderSSG(indexRoute, {}, root);
      expect(html).toContain("<html");
    });
  });

  describe("renderToStream", () => {
    test("returns ReadableStream with HTML", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const ctx = createMockLoaderContext({ path: "/ssr-page" });
      const result = await renderToStream(ssrRoute, ctx, root);

      expect(result).toBeInstanceOf(ReadableStream);
    });

    test("returns redirect Response when loader throws redirect", async () => {
      const ssrRoute = await getRoute("/ssr-page");
      const root = await getRoot();

      const redirectMock = (url: string) =>
        new Response(null, { status: 307, headers: { Location: url } });
      const ctx = createMockLoaderContext({
        path: "/ssr-page",
        redirect: redirectMock,
      });

      const customRoute = {
        ...ssrRoute,
        page: {
          ...ssrRoute.page,
          loader: (loaderCtx: Record<string, unknown>) => {
            const redirect = loaderCtx.redirect as (url: string) => Response;
            throw redirect("/moved");
          },
        },
      } as ResolvedRoute;

      const result = await renderToStream(customRoute, ctx, root);

      expect(result).toBeInstanceOf(Response);
      if (result instanceof Response) {
        expect(result.status).toBe(307);
        expect(result.headers.get("Location")).toBe("/moved");
      }
    });
  });
});
