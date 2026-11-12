import { describe, expect, test } from "bun:test";
import { applyLinkParams } from "../../../src/client/router/link-utils.ts";

describe("applyLinkParams", () => {
  test("substitutes :params into the pattern", () => {
    expect(applyLinkParams("/board/:boardId", { boardId: 42 })).toBe("/board/42");
    expect(applyLinkParams("/board/:boardId", { boardId: "42" })).toBe("/board/42");
  });

  test("URL-encodes named param values as one path segment", () => {
    expect(applyLinkParams("/post/:slug", { slug: "hello world/?#&%" })).toBe(
      "/post/hello%20world%2F%3F%23%26%25"
    );
  });

  test("substitutes multiple params", () => {
    expect(applyLinkParams("/board/:boardId/card/:cardId", { boardId: "1", cardId: "2" })).toBe(
      "/board/1/card/2"
    );
  });

  test("fills an optional segment, or drops it with its slash when absent", () => {
    expect(applyLinkParams("/:lang?/about", { lang: "fr" })).toBe("/fr/about");
    expect(applyLinkParams("/:lang?/about", {})).toBe("/about");
    expect(applyLinkParams("/docs/:lang?", {})).toBe("/docs");
    expect(applyLinkParams("/:lang?", {})).toBe("/");
  });

  test("replaces the wildcard segment from params._splat", () => {
    expect(applyLinkParams("/docs/*", { _splat: "a/b/c" })).toBe("/docs/a/b/c");
  });

  test("does not interpret dollar replacement sequences in wildcard values", () => {
    expect(applyLinkParams("/docs/*", { _splat: "foo$&bar" })).toBe("/docs/foo%24%26bar");
    expect(applyLinkParams("/docs/*", { _splat: "foo$1bar" })).toBe("/docs/foo%241bar");
  });

  test("URL-encodes each wildcard path segment", () => {
    expect(applyLinkParams("/docs/*", { _splat: "hello world/setup?#&%" })).toBe(
      "/docs/hello%20world/setup%3F%23%26%25"
    );
  });

  test("leaves unknown segments untouched", () => {
    expect(applyLinkParams("/board/:boardId", {})).toBe("/board/:boardId");
    expect(applyLinkParams("/board/:boardId", null)).toBe("/board/:boardId");
    expect(applyLinkParams("/board/:boardId", undefined)).toBe("/board/:boardId");
  });

  test("plain paths pass through unchanged", () => {
    expect(applyLinkParams("/about", { anything: 1 })).toBe("/about");
    expect(applyLinkParams("/about", undefined)).toBe("/about");
  });
});

test("drops an optional segment when no params are given", () => {
  expect(applyLinkParams("/:lang?/about", undefined)).toBe("/about");
  expect(applyLinkParams("/:lang?", null)).toBe("/");
});
