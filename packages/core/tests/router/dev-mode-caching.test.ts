import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import { Elysia } from "elysia";
import {
  __resetDevCacheInvalidator,
  invalidateDevCache,
  registerRouteDependencies,
  watchPagesForInvalidation,
} from "../../src/dev-cache-invalidator";
import { __resetCacheState, isrCache, setSSGCache, ssgCache } from "../../src/render/cache";
import { __resetTemplateState, setProductionTemplateContent } from "../../src/render/template";
import { createRoutePlugin, scanPages } from "../../src/router";
import { __setDevMode, IS_DEV } from "../../src/runtime-env";

const FIXTURES_DIR = join(import.meta.dirname, "../fixtures/pages");
const TEST_TEMPLATE =
  '<!DOCTYPE html><html><head><!--FURIN_HEAD--></head><body><div id="root"><!--FURIN_HTML--></div><!--FURIN_TAIL--></body></html>';

let originalDevMode: boolean;

beforeAll(() => {
  originalDevMode = IS_DEV;
  __setDevMode(false);
  setProductionTemplateContent(TEST_TEMPLATE);
});

afterEach(() => {
  __resetCacheState();
  __resetDevCacheInvalidator();
});
afterAll(() => {
  __setDevMode(originalDevMode);
  __resetTemplateState();
});

describe("dev mode SSG caching", () => {
  test("populates ssgCache after first request", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find((r) => r.pattern === "/ssg-page" && r.mode === "ssg");
    if (!ssgRoute) {
      throw new Error("No /ssg-page fixture with mode=ssg");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));
      const res = await app.handle(new Request("http://localhost/ssg-page"));

      expect(res.status).toBe(200);
      expect(ssgCache.has("/ssg-page")).toBe(true);
    } finally {
      __setDevMode(false);
    }
  });

  test("ISR route populates isrCache and reuses it on repeat requests", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const isrRoute = result.routes.find((r) => r.pattern === "/isr-page" && r.mode === "isr");
    if (!isrRoute) {
      throw new Error("No /isr-page fixture with mode=isr");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(isrRoute, result.root));
      await app.handle(new Request("http://localhost/isr-page"));

      const first = isrCache.get("/isr-page");
      expect(first).toBeDefined();

      await app.handle(new Request("http://localhost/isr-page"));
      const second = isrCache.get("/isr-page");

      expect(second?.generatedAt).toBe(first?.generatedAt);
    } finally {
      __setDevMode(false);
    }
  });

  test("invalidateDevCache(pagePath) clears that page's cached entry", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find((r) => r.pattern === "/ssg-page" && r.mode === "ssg");
    if (!ssgRoute) {
      throw new Error("No /ssg-page fixture with mode=ssg");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));
      await app.handle(new Request("http://localhost/ssg-page"));
      expect(ssgCache.has("/ssg-page")).toBe(true);

      const outcome = invalidateDevCache(ssgRoute.path);

      expect(ssgCache.has("/ssg-page")).toBe(false);
      expect(outcome.ssg).toBe(1);
      expect(outcome.isr).toBe(0);
      expect(outcome.cleared).toEqual(["/ssg-page"]);
    } finally {
      __setDevMode(false);
    }
  });

  test("invalidateDevCache(layoutPath) clears every descendant cache entry but leaves unrelated entries intact", () => {
    const layout = "/pages/board/_route.tsx";
    const unrelatedLayout = "/pages/home/_route.tsx";
    const now = Date.now();

    setSSGCache("/board/post-1", { html: "post-1", cachedAt: now, status: 200 });
    setSSGCache("/board/post-2", { html: "post-2", cachedAt: now, status: 200 });
    setSSGCache("/home", { html: "home", cachedAt: now, status: 200 });
    registerRouteDependencies("/board/post-1", ["/pages/board/post-1.tsx", layout]);
    registerRouteDependencies("/board/post-2", ["/pages/board/post-2.tsx", layout]);
    registerRouteDependencies("/home", ["/pages/home/index.tsx", unrelatedLayout]);

    const outcome = invalidateDevCache(layout);

    expect(outcome.ssg).toBe(2);
    expect(outcome.cleared.sort()).toEqual(["/board/post-1", "/board/post-2"]);
    expect(ssgCache.has("/board/post-1")).toBe(false);
    expect(ssgCache.has("/board/post-2")).toBe(false);
    expect(ssgCache.has("/home")).toBe(true);
  });

  test("invalidateDevCache(rootPath) clears every cached entry (nuclear)", () => {
    const rootPath = "/pages/root.tsx";
    const now = Date.now();

    setSSGCache("/board/post-1", { html: "post-1", cachedAt: now, status: 200 });
    setSSGCache("/home", { html: "home", cachedAt: now, status: 200 });
    registerRouteDependencies("/board/post-1", [
      "/pages/board/post-1.tsx",
      "/pages/board/_route.tsx",
      rootPath,
    ]);
    registerRouteDependencies("/home", ["/pages/home/index.tsx", rootPath]);

    const outcome = invalidateDevCache(rootPath);

    expect(outcome.ssg).toBe(2);
    expect(outcome.cleared.sort()).toEqual(["/board/post-1", "/home"]);
    expect(ssgCache.size).toBe(0);
  });

  test("invalidation logs a [furin:cache] line with counts and path", () => {
    const now = Date.now();
    setSSGCache("/home", { html: "home", cachedAt: now, status: 200 });
    registerRouteDependencies("/home", ["/pages/home/index.tsx"]);

    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      invalidateDevCache("/pages/home/index.tsx");
    } finally {
      console.log = originalLog;
    }

    const furinLog = messages.find((m) => m.includes("[furin:cache]"));
    expect(furinLog).toBeDefined();
    expect(furinLog).toContain("/pages/home/index.tsx");
    expect(furinLog).toContain("ssg: 1");
    expect(furinLog).toContain("isr: 0");
  });

  test("watchPagesForInvalidation drops cache entries when a file under pagesDir changes", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "furin-watch-"));
    const pagePath = join(tmpRoot, "ssg-page.tsx");
    writeFileSync(pagePath, "// initial\n");

    try {
      const now = Date.now();
      setSSGCache("/ssg-page", { html: "initial", cachedAt: now, status: 200 });
      registerRouteDependencies("/ssg-page", [pagePath]);

      watchPagesForInvalidation(tmpRoot);
      writeFileSync(pagePath, "// edited\n");

      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (!ssgCache.has("/ssg-page") || Date.now() > deadline) {
            resolve();
          } else {
            setTimeout(poll, 25);
          }
        };
        poll();
      });

      expect(ssgCache.has("/ssg-page")).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("watchPagesForInvalidation recurses into nested directories", async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "furin-watch-"));
    const nestedDir = join(tmpRoot, "board");
    mkdirSync(nestedDir);
    const layoutPath = join(nestedDir, "_route.tsx");
    writeFileSync(layoutPath, "// initial\n");

    try {
      const now = Date.now();
      setSSGCache("/board/post-1", { html: "initial", cachedAt: now, status: 200 });
      registerRouteDependencies("/board/post-1", [layoutPath]);

      watchPagesForInvalidation(tmpRoot);
      writeFileSync(layoutPath, "// edited\n");

      await new Promise<void>((resolve) => {
        const deadline = Date.now() + 2000;
        const poll = () => {
          if (!ssgCache.has("/board/post-1") || Date.now() > deadline) {
            resolve();
          } else {
            setTimeout(poll, 25);
          }
        };
        poll();
      });

      expect(ssgCache.has("/board/post-1")).toBe(false);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  test("no log line when nothing is cleared", () => {
    const messages: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      messages.push(args.map(String).join(" "));
    };
    try {
      invalidateDevCache("/pages/never-registered.tsx");
    } finally {
      console.log = originalLog;
    }

    expect(messages.some((m) => m.includes("[furin:cache]"))).toBe(false);
  });

  test("serves identical cached HTML on repeat requests", async () => {
    const result = await scanPages(FIXTURES_DIR);
    const ssgRoute = result.routes.find((r) => r.pattern === "/ssg-page" && r.mode === "ssg");
    if (!ssgRoute) {
      throw new Error("No /ssg-page fixture with mode=ssg");
    }

    __setDevMode(true);
    try {
      const app = new Elysia().use(createRoutePlugin(ssgRoute, result.root));
      await app.handle(new Request("http://localhost/ssg-page"));
      const cachedAtFirst = ssgCache.get("/ssg-page")?.cachedAt;

      await app.handle(new Request("http://localhost/ssg-page"));
      const cachedAtSecond = ssgCache.get("/ssg-page")?.cachedAt;

      expect(cachedAtSecond).toBe(cachedAtFirst);
    } finally {
      __setDevMode(false);
    }
  });

  test("invalidateDevCache clears routes that depend on an intermediate _route.ts file", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "furin-route-ts-"));
    mkdirSync(join(tempDir, "docs"), { recursive: true });

    writeFileSync(
      join(tempDir, "root.tsx"),
      ['export const route = { __type: "FURIN_ROUTE", layout: ({ children }) => children };'].join(
        "\n"
      )
    );

    writeFileSync(
      join(tempDir, "docs", "_route.ts"),
      [
        'import { route as rootRoute } from "../root.tsx";',
        "",
        "export const route = {",
        '  __type: "FURIN_ROUTE",',
        "  parent: rootRoute,",
        "  layout: ({ children }) => children,",
        "};",
      ].join("\n")
    );

    writeFileSync(
      join(tempDir, "docs", "index.tsx"),
      [
        'import { route } from "./_route.ts";',
        "",
        "export default {",
        '  __type: "FURIN_PAGE",',
        "  _route: route,",
        "  component: () => null,",
        "};",
      ].join("\n")
    );

    try {
      const result = await scanPages(tempDir);
      const route = result.routes.find(
        (entry) => entry.pattern === "/docs" && entry.mode === "ssg"
      );
      if (!route) {
        throw new Error("No /docs fixture with mode=ssg");
      }

      __setDevMode(true);
      try {
        const app = new Elysia().use(createRoutePlugin(route, result.root));
        const res = await app.handle(new Request("http://localhost/docs"));

        expect(res.status).toBe(200);
        expect(ssgCache.has("/docs")).toBe(true);

        const outcome = invalidateDevCache(join(tempDir, "docs", "_route.ts"));

        expect(outcome.ssg).toBe(1);
        expect(outcome.cleared).toEqual(["/docs"]);
        expect(ssgCache.has("/docs")).toBe(false);
      } finally {
        __setDevMode(false);
      }
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
