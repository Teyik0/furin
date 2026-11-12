import { describe, expect, test } from "bun:test";
import { resolvePath } from "../../../src/server/render/assemble.ts";
import {
  buildRouteMatcher,
  buildRouteRegex,
  compareRouteSpecificity,
  escapeRegExp,
  routePatternRegexSource,
} from "../../../src/server/router/patterns.ts";

test("decoded route params preserve their segment boundary in rendered cache paths", () => {
  const match = buildRouteMatcher([{ pattern: "/item/:id" }])("/item/a%2Fb");
  expect(match?.params.id).toBe("a/b");
  expect(resolvePath("/item/:id", match?.params ?? {})).toBe("/item/a%2Fb");
  expect(resolvePath("/item/*", { _splat: "a/b" })).toBe("/item/a/b");
  expect(resolvePath("/item/:id", { id: "a?b#c%" })).toBe("/item/a%3Fb%23c%25");
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
    ).toEqual({ paramNames: ["org", "repo", "_splat"], source: "/v1\\.0/[^/]+/[^/]+(?:/(?:.*))?" });
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

describe("optional params and splats", () => {
  test("an optional segment matches with and without the segment", () => {
    const route = { pattern: "/:lang?/about" };
    const matcher = buildRouteMatcher([route]);
    expect(matcher("/about")).toEqual({ params: {}, route });
    expect(matcher("/fr/about")).toEqual({ params: { lang: "fr" }, route });
    expect(matcher("/fr/de/about")).toBeNull();
  });

  test("a catch-all is exposed as _splat", () => {
    expect(buildRouteMatcher([{ pattern: "/docs/*" }])("/docs/a/b")?.params).toEqual({
      _splat: "a/b",
    });
  });

  test("paths fill or drop optional segments", () => {
    expect(resolvePath("/:lang?/about", { lang: "fr" })).toBe("/fr/about");
    expect(resolvePath("/:lang?/about", {})).toBe("/about");
    expect(resolvePath("/docs/:lang?", {})).toBe("/docs");
  });

  test("an optional pattern ranks as its most specific variant", () => {
    expect(compareRouteSpecificity("/:lang?/about", "/:id")).toBeGreaterThan(0);
    expect(compareRouteSpecificity("/:lang?/about", "/about/:id")).toBeLessThan(0);
  });
});

describe("review: optional params rank like Elysia", () => {
  test("a static variant of an optional pattern beats a param route", () => {
    const optional = { pattern: "/:lang?/about" };
    const param = { pattern: "/:id" };
    expect(buildRouteMatcher([param, optional])("/about")?.route).toBe(optional);
    expect(buildRouteMatcher([param, optional])("/fr/about")?.route).toBe(optional);
    expect(buildRouteMatcher([param, optional])("/x")?.route).toBe(param);
  });

  test("a catch-all also serves its bare parent path with an empty splat, as Elysia does", () => {
    const matcher = buildRouteMatcher([{ pattern: "/docs/*" }]);
    expect(matcher("/docs")?.params).toEqual({ _splat: "" });
    expect(matcher("/docs/")?.params).toEqual({ _splat: "" });
    expect(matcher("/docs/a/b")?.params).toEqual({ _splat: "a/b" });
    expect(matcher("/docsx")).toBeNull();
  });

  test("a static sibling still wins its exact path over the catch-all", () => {
    const docs = { pattern: "/docs" };
    expect(buildRouteMatcher([{ pattern: "/docs/*" }, docs])("/docs")?.route).toBe(docs);
  });
});
