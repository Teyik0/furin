import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../src/router.ts";

const ERROR_FIXTURES_DIR = join(import.meta.dirname, "..", "fixtures", "pages-error-nested");

describe("scanPages — error.tsx discovery", () => {
  test("exposes root error component on root layout", async () => {
    const result = await scanPages(ERROR_FIXTURES_DIR);

    expect(result.root.error).toBeDefined();
    expect(typeof result.root.error).toBe("function");
  });

  test("does not register error.tsx as a page route", async () => {
    const result = await scanPages(ERROR_FIXTURES_DIR);

    const patterns = result.routes.map((r) => r.pattern);
    expect(patterns).not.toContain("/error");
  });

  test("attaches nearest error.tsx to each route", async () => {
    const result = await scanPages(ERROR_FIXTURES_DIR);

    const blogRoute = result.routes.find((r) => r.pattern === "/blog");
    const homeRoute = result.routes.find((r) => r.pattern === "/");

    expect(blogRoute?.error).toBeDefined();
    expect(homeRoute?.error).toBeDefined();

    expect(blogRoute?.error).not.toBe(result.root.error);
    expect(homeRoute?.error).toBe(result.root.error);
  });
});
