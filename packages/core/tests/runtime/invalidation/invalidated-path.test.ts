import { describe, expect, test } from "bun:test";
import { isInvalidatedPath } from "../../../src/shared/invalidation-header.ts";

describe("isInvalidatedPath", () => {
  test("a page invalidation only matches the exact path", () => {
    expect(isInvalidatedPath("/blog", "/blog", "page")).toBe(true);
    expect(isInvalidatedPath("/blog/post", "/blog", "page")).toBe(false);
  });

  test("a layout invalidation matches the path and its descendants on a segment boundary", () => {
    expect(isInvalidatedPath("/blog", "/blog", "layout")).toBe(true);
    expect(isInvalidatedPath("/blog/post", "/blog", "layout")).toBe(true);
    expect(isInvalidatedPath("/blog/post", "/blog/", "layout")).toBe(true);
    expect(isInvalidatedPath("/blogger", "/blog", "layout")).toBe(false);
  });

  test("a root layout invalidation matches every path", () => {
    expect(isInvalidatedPath("/any/where", "/", "layout")).toBe(true);
  });
});
