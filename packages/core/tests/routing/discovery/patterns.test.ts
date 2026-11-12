import { describe, expect, test } from "bun:test";
import { resolvePath } from "../../../src/server/render/assemble.ts";
import {
  buildRouteMatcher,
  buildRouteRegex,
  compareRouteSpecificity,
  escapeRegExp,
  filePathToPattern,
  routePatternRegexSource,
} from "../../../src/server/router/patterns.ts";

test("decoded route params preserve their segment boundary in rendered cache paths", () => {
  const match = buildRouteMatcher([{ pattern: "/item/:id" }])("/item/a%2Fb");
  expect(match?.params.id).toBe("a/b");
  expect(resolvePath("/item/:id", match?.params ?? {})).toBe("/item/a%2Fb");
  expect(resolvePath("/item/*", { "*": "a/b" })).toBe("/item/a/b");
  expect(resolvePath("/item/:id", { id: "a?b#c%" })).toBe("/item/a%3Fb%23c%25");
});

describe("filePathToPattern", () => {
  test.each([
    ["index.tsx", "/"],
    ["about.tsx", "/about"],
    ["blog/index.tsx", "/blog"],
    ["blog/post.tsx", "/blog/post"],
    ["blog/[slug].tsx", "/blog/:slug"],
    ["[id].tsx", "/:id"],
    ["docs/[...path].tsx", "/docs/*"],
    ["[...catch].tsx", "/*"],
    ["a/b/c/index.tsx", "/a/b/c"],
    ["blog/[category]/[slug].tsx", "/blog/:category/:slug"],
    // Group directories are omitted around dynamic and catch-all segments.
    ["(admin)/users/(details)/[id].tsx", "/users/:id"],
    ["docs/(guides)/[...path].tsx", "/docs/*"],
    ["(admin)\\users\\[id].tsx", "/users/:id"],
    // Parentheses in filenames and ordinary directory names are kept.
    ["(admin).tsx", "/(admin)"],
    ["release(beta)/index.tsx", "/release(beta)"],
    ["users/[userId]/posts/[postId].tsx", "/users/:userId/posts/:postId"],
    ["dashboard/settings/index.tsx", "/dashboard/settings"],
    ["api/v1/users.tsx", "/api/v1/users"],
    ["api/users/[id]/settings.tsx", "/api/users/:id/settings"],
  ])("converts %p to %p", (filePath, pattern) => {
    expect(filePathToPattern(filePath)).toBe(pattern);
  });

  test("rejects dynamic parameter names that Elysia cannot route", () => {
    expect(() => filePathToPattern("blog/[post-id].tsx")).toThrow(
      '[furin] Invalid dynamic parameter "post-id" in "blog/[post-id].tsx"'
    );
    expect(() => filePathToPattern("blog/[123id].tsx")).toThrow(
      '[furin] Invalid dynamic parameter "123id" in "blog/[123id].tsx"'
    );
    expect(() => filePathToPattern("docs/[...docs-path].tsx")).toThrow(
      '[furin] Invalid dynamic parameter "docs-path" in "docs/[...docs-path].tsx"'
    );
  });
});

describe("compareRouteSpecificity", () => {
  const moreSpecific = (a: string, b: string) => compareRouteSpecificity(a, b) > 0;

  test("literal segment outranks :param at the same position", () => {
    expect(moreSpecific("/users/new", "/users/:id")).toBe(true);
    expect(compareRouteSpecificity("/users/:id", "/users/new")).toBeLessThan(0);
  });

  test(":param outranks wildcard at the same position", () => {
    expect(moreSpecific("/docs/:section", "/docs/*")).toBe(true);
  });

  test("literal outranks wildcard at the same position", () => {
    expect(moreSpecific("/docs/api", "/docs/*")).toBe(true);
  });

  test("breaks the summed-weight tie by leftmost differing segment", () => {
    // Both summed to 8 under the old scoring (literal 3 + literal/param mix).
    // The literal `new` at position 1 wins over the `:id` param.
    expect(moreSpecific("/blog/new/:section", "/blog/:id/edit")).toBe(true);
  });

  test("is sign-consistent when arguments are swapped", () => {
    expect(compareRouteSpecificity("/blog/new/:section", "/blog/:id/edit")).toBeGreaterThan(0);
    expect(compareRouteSpecificity("/blog/:id/edit", "/blog/new/:section")).toBeLessThan(0);
  });

  test("more explicit segments outrank a shorter wildcard tail", () => {
    expect(moreSpecific("/docs/api/v1", "/docs/*")).toBe(true);
  });

  test("the root route outranks a root catch-all", () => {
    expect(moreSpecific("/", "/*")).toBe(true);
    expect(compareRouteSpecificity("/*", "/")).toBeLessThan(0);
  });

  test("returns 0 for identical patterns", () => {
    expect(compareRouteSpecificity("/blog/:id", "/blog/:id")).toBe(0);
  });
});

describe("buildRouteRegex", () => {
  test("escapes regex metacharacters in static route segments", () => {
    const { regex } = buildRouteRegex("/release/v1.0+stable");

    expect(regex.test("/release/v1.0+stable")).toBe(true);
    expect(regex.test("/release/v1x0+stable")).toBe(false);
    expect(regex.test("/release/v1.00stable")).toBe(false);
  });
});

describe("escapeRegExp", () => {
  test("matches the value literally", () => {
    const value = "/a.b+c?(d)[e]{f}|g^h$i*j\\k";

    expect(new RegExp(`^${escapeRegExp(value)}$`).test(value)).toBe(true);
    expect(new RegExp(`^${escapeRegExp("/a.b")}$`).test("/axb")).toBe(false);
  });
});

describe("routePatternRegexSource", () => {
  test("substitutes the given sources for params and catch-alls, in order", () => {
    expect(
      routePatternRegexSource("/v1.0/:org/:repo/*", { catchAll: "(?:.*)", param: "[^/]+" })
    ).toEqual({ paramNames: ["org", "repo", "*"], source: "/v1\\.0/[^/]+/[^/]+/(?:.*)" });
  });
});

describe("buildRouteMatcher", () => {
  test("precompiles route regexes and returns the most specific match", () => {
    const staticRoute = { pattern: "/users/new" };
    const dynamicRoute = { pattern: "/users/:id" };
    const matcher = buildRouteMatcher([dynamicRoute, staticRoute]);

    expect(matcher("/users/new")).toEqual({ params: {}, route: staticRoute });
    expect(matcher("/users/123")).toEqual({ params: { id: "123" }, route: dynamicRoute });
  });

  test("does not treat static dots as wildcards", () => {
    const route = { pattern: "/v1.0" };
    const matcher = buildRouteMatcher([route]);

    expect(matcher("/v1.0")).toEqual({ params: {}, route });
    expect(matcher("/v1x0")).toBeNull();
  });
});
