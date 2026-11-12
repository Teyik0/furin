import { describe, expect, test } from "bun:test";
import type { MetaDescriptor } from "../../../src/client";
import {
  escapeHtml,
  extractTitle,
  generateIndexHtml,
  generateProdIndexHtml,
  safeJson,
} from "../../../src/server/render/shell.ts";

describe("shell.tsx", () => {
  test("generated framework templates do not impose an application theme", () => {
    expect(generateIndexHtml()).not.toContain("furin-theme");
    expect(generateProdIndexHtml("/app.js", [], undefined, undefined, false)).not.toContain(
      "furin-theme"
    );
  });

  describe("safeJson", () => {
    test("escapes </script> — prevents script tag breakout", () => {
      expect(safeJson({ x: "</script><script>alert(1)</script>" })).toBe(
        '{"x":"\\u003c/script\\u003e\\u003cscript\\u003ealert(1)\\u003c/script\\u003e"}'
      );
    });

    test("safe data is unchanged (round-trips through JSON.parse)", () => {
      const data = { a: 1, b: "hello", c: true, d: null };
      expect(JSON.parse(safeJson(data))).toEqual(data);
    });

    test("< and > in values are replaced with unicode escapes", () => {
      expect(safeJson({ v: "<b>bold</b>" })).toBe('{"v":"\\u003cb\\u003ebold\\u003c/b\\u003e"}');
    });

    test("values without < are not modified", () => {
      expect(safeJson({ n: 42, s: "hello" })).toBe('{"n":42,"s":"hello"}');
    });

    test("nested objects with < are escaped recursively", () => {
      const result = safeJson({ outer: { inner: "</script>" } });
      expect(result).not.toContain("</script>");
      expect(JSON.parse(result)).toEqual({ outer: { inner: "</script>" } });
    });
  });

  describe("escapeHtml", () => {
    test("escapes & character", () => {
      expect(escapeHtml("foo & bar")).toBe("foo &amp; bar");
    });

    test("escapes < character", () => {
      expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
    });

    test("escapes > character", () => {
      expect(escapeHtml("a > b")).toBe("a &gt; b");
    });

    test("escapes double quote", () => {
      expect(escapeHtml('say "hello"')).toBe("say &quot;hello&quot;");
    });

    test("escapes single quote", () => {
      expect(escapeHtml("it's")).toBe("it&#039;s");
    });

    test("handles empty string", () => {
      expect(escapeHtml("")).toBe("");
    });

    test("handles string without special chars", () => {
      expect(escapeHtml("hello world")).toBe("hello world");
    });
  });

  describe("extractTitle", () => {
    test("extracts title from meta array", () => {
      const meta: MetaDescriptor[] = [{ title: "My Page" }];
      expect(extractTitle(meta)).toBe("My Page");
    });

    test("extracts title from mixed meta array", () => {
      const meta: MetaDescriptor[] = [
        { content: "test", name: "description" },
        { title: "First Title" },
        { title: "Second Title" },
      ];
      expect(extractTitle(meta)).toBe("First Title");
    });

    test("returns undefined when no title in array", () => {
      const meta: MetaDescriptor[] = [
        { content: "test", name: "description" },
        { charSet: "utf-8" },
      ];
      expect(extractTitle(meta)).toBeUndefined();
    });

    test("returns undefined for undefined meta", () => {
      expect(extractTitle(undefined)).toBeUndefined();
    });

    test("returns undefined for empty array", () => {
      expect(extractTitle([])).toBeUndefined();
    });
  });
});
