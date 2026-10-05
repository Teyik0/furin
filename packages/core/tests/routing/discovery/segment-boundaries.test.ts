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
import { join } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";

const ERROR_NESTED_DIR = join(import.meta.dirname, "../../fixtures/pages/nested-errors");
const ERROR_NESTED_POSIX_DIR = ERROR_NESTED_DIR.replaceAll("\\", "/");
const NOT_FOUND_NESTED_DIR = join(import.meta.dirname, "../../fixtures/pages/nested-not-found");
const BARE_DIR = join(import.meta.dirname, "../../fixtures/pages/default");

describe("segmentBoundaries — chain population", () => {
  test("each route exposes a segmentBoundaries array", async () => {
    const { routes } = await scanPages(ERROR_NESTED_DIR);
    for (const r of routes) {
      expect(Array.isArray(r.segmentBoundaries)).toBe(true);
    }
  });

  test("bare fixture with no conventions produces empty chains", async () => {
    const { routes } = await scanPages(BARE_DIR);
    for (const r of routes) {
      expect(r.segmentBoundaries).toEqual([]);
    }
  });

  test("nested error fixture: /blog has two boundaries — root error and blog error", async () => {
    const { routes } = await scanPages(ERROR_NESTED_DIR);
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
    const { routes } = await scanPages(NOT_FOUND_NESTED_DIR);
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
    const { routes } = await scanPages(ERROR_NESTED_DIR);
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
    const { routes } = await scanPages(ERROR_NESTED_DIR);
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
