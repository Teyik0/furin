import { describe, expect, test } from "bun:test";
import {
  assertNoPrefixSlugCollisions,
  clientDirNameForPrefix,
  prefixSlug,
} from "../../../src/shared/prefix";

describe("clientDirNameForPrefix / prefixSlug", () => {
  test("root prefix keeps the historical client/ dir", () => {
    expect(clientDirNameForPrefix("")).toBe("client");
  });

  test("prefixed apps get client-<slug>/ with slashes flattened to dashes", () => {
    expect(prefixSlug("/admin")).toBe("admin");
    expect(prefixSlug("/admin/v2")).toBe("admin-v2");
    expect(clientDirNameForPrefix("/admin/v2")).toBe("client-admin-v2");
  });

  test("preserves percent escapes for Unicode and reserved characters", () => {
    for (const segment of ["café", "東京", "a:b", "[id]", "a\\b", "a;b", "%41", "A*"]) {
      expect(decodeURIComponent(prefixSlug(`/${segment}`))).toBe(segment);
    }
    expect(prefixSlug("/café")).toBe("caf%C3%A9");
    expect(prefixSlug("/a:b")).toBe("a%3Ab");
  });
});

describe("assertNoPrefixSlugCollisions", () => {
  test("accepts distinct prefixes with distinct slugs", () => {
    expect(() => assertNoPrefixSlugCollisions(["", "/admin", "/shop/v2"])).not.toThrow();
  });

  test("accepts repeated occurrences of the same prefix", () => {
    // Exact duplicates are the duplicate-prefix check's job, not a slug collision.
    expect(() => assertNoPrefixSlugCollisions(["/admin", "/admin"])).not.toThrow();
  });

  test("encodes separators so distinct prefixes cannot overwrite artifacts", () => {
    const prefixes = ["/a-b", "/a/b", "/a__b", "/a%2Db", "/.", "/.."];
    expect(new Set(prefixes.map(prefixSlug)).size).toBe(prefixes.length);
    expect(() => assertNoPrefixSlugCollisions(prefixes)).not.toThrow();
    expect(prefixSlug("/.")).not.toBe(".");
    expect(prefixSlug("/..")).not.toBe("..");
  });

  test("keeps case-distinct mounts separate on case-insensitive filesystems", () => {
    const prefixes = ["/admin", "/Admin", "/ADMIN", "/%41dmin"];
    expect(new Set(prefixes.map((prefix) => prefixSlug(prefix).toLowerCase())).size).toBe(
      prefixes.length
    );
  });

  test("encodes Windows wildcard characters in generated directories", () => {
    expect(prefixSlug("/assets*")).not.toContain("*");
    expect(prefixSlug("/assets*")).not.toBe(prefixSlug("/assets%2A"));
  });
});
