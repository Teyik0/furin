import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../src/router.ts";

const FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "pages-not-found");
const NESTED_FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "pages-not-found-nested");

describe("scanPages — not-found discovery", () => {
  test("exposes root not-found component on root layout", async () => {
    const result = await scanPages(FIXTURES_DIR);

    expect(result.root.notFound).toBeDefined();
    expect(typeof result.root.notFound).toBe("function");
  });

  test("does not register not-found.tsx as a page route", async () => {
    const result = await scanPages(FIXTURES_DIR);

    const patterns = result.routes.map((r) => r.pattern);
    expect(patterns).not.toContain("/not-found");
  });

  test("attaches nearest not-found.tsx to each route", async () => {
    const result = await scanPages(NESTED_FIXTURES_DIR);

    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    const homeRoute = result.routes.find((r) => r.pattern === "/");

    expect(blogRoute?.notFound).toBeDefined();
    expect(homeRoute?.notFound).toBeDefined();

    // Blog route's nearest not-found is the nested one — distinct from root's.
    expect(blogRoute?.notFound).not.toBe(result.root.notFound);
    // Home route has no segment above root → falls back to root's not-found.
    expect(homeRoute?.notFound).toBe(result.root.notFound);
  });
});
