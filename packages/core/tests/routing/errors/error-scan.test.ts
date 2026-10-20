import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { scanPages } from "../../../src/server/router/discovery.ts";

const ERROR_FIXTURES_DIR = join(import.meta.dirname, "../../fixtures/pages/nested-errors");

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

    const nearestError = (pattern: string) =>
      result.routes.find((r) => r.pattern === pattern)?.segmentBoundaries.findLast((b) => b.error)
        ?.error;

    expect(nearestError("/blog")).toBeDefined();
    expect(nearestError("/blog")).not.toBe(result.root.error);
    expect(nearestError("/")).toBe(result.root.error);
  });
});
