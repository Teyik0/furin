/**
 * segmentBoundaries — per-directory ownership of error.tsx / not-found.tsx.
 *
 * Each ResolvedRoute carries an ordered chain (shallow → deep) of boundaries
 * it traverses. Entries hold the DIRECTORY'S OWN conventions (never inherited)
 * so the render layer can insert React error boundaries at the exact segment
 * that declared them — mirroring Next.js app router's nested model.
 *
 * This slice ships the data model only; rendering uses it in slice 5.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";

const ERROR_NESTED_DIR = join(import.meta.dirname, "../../fixtures/pages/nested-errors");
const ERROR_NESTED_POSIX_DIR = ERROR_NESTED_DIR.replaceAll("\\", "/");
const NOT_FOUND_NESTED_DIR = join(import.meta.dirname, "../../fixtures/pages/nested-not-found");
const BARE_DIR = join(import.meta.dirname, "../../fixtures/pages/default");

const next = (pagesDir: string) => ({ pagesDir, prefix: "", style: "nextjs" as const });

describe("segmentBoundaries — chain population", () => {
  test("each route exposes a segmentBoundaries array", async () => {
    const { routes } = await scanPages(next(ERROR_NESTED_DIR));
    for (const r of routes) {
      expect(Array.isArray(r.segmentBoundaries)).toBe(true);
    }
  });

  test("bare TanStack fixture without .error()/.notFound() produces empty chains", async () => {
    const { routes } = await scanPages({ pagesDir: BARE_DIR, prefix: "", style: "tanstack" });
    for (const r of routes) {
      expect(r.segmentBoundaries).toEqual([]);
    }
  });

  test("nested error fixture: /blog has two boundaries — root error and blog error", async () => {
    const { routes } = await scanPages(next(ERROR_NESTED_DIR));
    const blog = routes.find((r) => r.pattern === "/blog");
    if (!blog) {
      throw new Error("expected /blog fixture route");
    }

    expect(blog.segmentBoundaries).toHaveLength(2);

    const [root, blogSegment] = blog.segmentBoundaries;
    expect(root?.path).toBe(ERROR_NESTED_POSIX_DIR);
    expect(root?.depth).toBe(0);
    expect(root?.error).toBeDefined();
    expect(root?.notFound).toBeUndefined();

    expect(blogSegment?.path).toBe(`${ERROR_NESTED_POSIX_DIR}/blog`);
    // The blog directory has no layout, so both boundaries wrap inside root.
    expect(blogSegment?.depth).toBe(0);
    expect(blogSegment?.error).toBeDefined();
    expect(blogSegment?.notFound).toBeUndefined();

    // Own-only semantics: the blog entry's error MUST NOT be the root error.
    expect(blogSegment?.error).not.toBe(root?.error);
  });

  test("nested not-found fixture: /blog has two boundaries with own not-found components", async () => {
    const { routes } = await scanPages(next(NOT_FOUND_NESTED_DIR));
    const blog = routes.find((r) => r.pattern === "/blog");
    if (!blog) {
      throw new Error("expected /blog fixture route");
    }

    expect(blog.segmentBoundaries).toHaveLength(2);

    const [root, blogSegment] = blog.segmentBoundaries;
    expect(root?.depth).toBe(0);
    expect(root?.notFound).toBeDefined();
    expect(root?.error).toBeUndefined();

    expect(blogSegment?.depth).toBe(0);
    expect(blogSegment?.notFound).toBeDefined();
    expect(blogSegment?.error).toBeUndefined();

    expect(blogSegment?.notFound).not.toBe(root?.notFound);
  });

  test("chain is ordered shallow → deep by depth", async () => {
    const { routes } = await scanPages(next(ERROR_NESTED_DIR));
    for (const r of routes) {
      for (let i = 1; i < r.segmentBoundaries.length; i += 1) {
        const prev = r.segmentBoundaries[i - 1];
        const curr = r.segmentBoundaries[i];
        expect(curr?.depth).toBeGreaterThanOrEqual(prev?.depth ?? -1);
      }
    }
  });

  test("route under a directory with no conventions excludes that directory from the chain", async () => {
    // In pages-error-nested, the homepage (/) lives in pagesDir — only root
    // qualifies. The chain has length 1, no blog entry.
    const { routes } = await scanPages(next(ERROR_NESTED_DIR));
    const home = routes.find((r) => r.pattern === "/");
    if (!home) {
      throw new Error("expected / fixture route");
    }
    expect(home.segmentBoundaries).toHaveLength(1);
    expect(home.segmentBoundaries[0]?.path).toBe(ERROR_NESTED_POSIX_DIR);

    // /blog/subpage lives under blog/subpage, where subpage has no conventions.
    // The chain should include root and blog, but NOT subpage.
    const subpage = routes.find((r) => r.pattern === "/blog/subpage");
    if (!subpage) {
      throw new Error("expected /blog/subpage fixture route");
    }
    expect(subpage.segmentBoundaries).toHaveLength(2);
    expect(subpage.segmentBoundaries[0]?.path).toBe(ERROR_NESTED_POSIX_DIR);
    expect(subpage.segmentBoundaries[1]?.path).toBe(`${ERROR_NESTED_POSIX_DIR}/blog`);
    expect(
      subpage.segmentBoundaries.some((b) => b.path === `${ERROR_NESTED_POSIX_DIR}/blog/subpage`)
    ).toBe(false);
  });
});

describe("segmentBoundaries — TanStack .error() / .notFound()", () => {
  const furin = JSON.stringify(join(import.meta.dirname, "../../../src/furin.ts"));
  const files = {
    "__root.tsx": `import { defineRootRoute } from ${furin};
export const RootError = () => null;
export const route = defineRootRoute().config({ mode: "ssr" }).error(RootError).layout(({ children }) => children);`,
    "board/$id.tsx": `import { defineRoute } from ${furin};
export const PageError = () => null;
export const route = defineRoute("/board/$id").config({ mode: "ssr" }).error(PageError).page(() => null);`,
    "board/route.tsx": `import { defineRoute } from ${furin};
export const BoardNotFound = () => null;
export const route = defineRoute("/board").config({ mode: "ssr" }).notFound(BoardNotFound).layout(({ children }) => children);`,
    "index.tsx": `import { defineRoute } from ${furin};
export const route = defineRoute("/").config({ mode: "ssr" }).page(() => null);`,
  };

  test("a route's boundary renders in its parent's outlet; the root's is the root boundary", async () => {
    const pagesDir = mkdtempSync(join(tmpdir(), "furin-route-boundaries-")).replaceAll("\\", "/");
    const initialDevMode = IS_DEV;
    __setDevMode(false);
    try {
      for (const [file, contents] of Object.entries(files)) {
        mkdirSync(join(pagesDir, file, ".."), { recursive: true });
        writeFileSync(join(pagesDir, file), contents);
      }
      const { root, routes } = await scanPages({ pagesDir, prefix: "", style: "tanstack" });
      const rootModule = await import(`${pagesDir}/__root.tsx`);
      const board = await import(`${pagesDir}/board/route.tsx`);
      const page = await import(`${pagesDir}/board/$id.tsx`);

      expect(root.error).toBe(rootModule.RootError);
      expect(root.notFound).toBeUndefined();

      const detail = routes.find((route) => route.pattern === "/board/:id");
      expect(detail?.segmentBoundaries).toEqual([
        {
          depth: 0,
          error: rootModule.RootError,
          errorPath: `${pagesDir}/__root.tsx`,
          fromRoute: true,
          notFound: undefined,
          notFoundPath: undefined,
          path: pagesDir,
        },
        {
          depth: 0,
          error: undefined,
          errorPath: undefined,
          fromRoute: true,
          notFound: board.BoardNotFound,
          notFoundPath: `${pagesDir}/board/route.tsx`,
          path: `${pagesDir}/board/route.tsx`,
        },
        {
          depth: 1,
          error: page.PageError,
          errorPath: `${pagesDir}/board/$id.tsx`,
          fromRoute: true,
          notFound: undefined,
          notFoundPath: undefined,
          path: `${pagesDir}/board/$id.tsx`,
        },
      ]);
      const home = routes.find((route) => route.pattern === "/");
      expect(home?.segmentBoundaries.map(({ depth, path }) => ({ depth, path }))).toEqual([
        { depth: 0, path: pagesDir },
      ]);
    } finally {
      __setDevMode(initialDevMode);
      rmSync(pagesDir, { force: true, recursive: true });
    }
  });
});
