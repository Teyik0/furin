import { describe, expect, test } from "bun:test";
import type { HeadOptions, MetaDescriptor } from "../src/client";
import {
  buildHeadInjection,
  buildLinkParts,
  buildMetaParts,
  buildScriptParts,
  buildStyleParts,
  escapeHtml,
  extractTitle,
  isMetaTag,
  renderAttrs,
  safeJson,
} from "../src/shell";

describe("shell.tsx", () => {
  describe("safeJson", () => {
    test("escapes </script> — prevents script tag breakout", () => {
      expect(safeJson({ x: "</script><script>alert(1)</script>" })).toBe(
        '{"x":"\\u003c/script>\\u003cscript>alert(1)\\u003c/script>"}'
      );
    });

    test("safe data is unchanged (round-trips through JSON.parse)", () => {
      const data = { a: 1, b: "hello", c: true, d: null };
      expect(JSON.parse(safeJson(data))).toEqual(data);
    });

    test("< in values is replaced with \\u003c", () => {
      expect(safeJson({ v: "<b>bold</b>" })).toBe('{"v":"\\u003cb>bold\\u003c/b>"}');
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
        { name: "description", content: "test" },
        { title: "First Title" },
        { title: "Second Title" },
      ];
      expect(extractTitle(meta)).toBe("First Title");
    });

    test("returns undefined when no title in array", () => {
      const meta: MetaDescriptor[] = [
        { name: "description", content: "test" },
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

  describe("isMetaTag", () => {
    test("returns true for standard meta tag with name", () => {
      expect(isMetaTag({ name: "description", content: "test" })).toBe(true);
    });

    test("returns true for standard meta tag with property", () => {
      expect(isMetaTag({ property: "og:title", content: "test" })).toBe(true);
    });

    test("returns false for title entry", () => {
      expect(isMetaTag({ title: "My Page" })).toBe(false);
    });

    test("returns false for charSet entry", () => {
      expect(isMetaTag({ charSet: "utf-8" })).toBe(false);
    });

    test("returns false for script:ld+json entry", () => {
      expect(isMetaTag({ "script:ld+json": { "@type": "Thing" } })).toBe(false);
    });

    test("returns false for tagName entry", () => {
      expect(isMetaTag({ tagName: "meta", name: "viewport", content: "width=device-width" })).toBe(
        false
      );
    });
  });

  describe("renderAttrs", () => {
    test("renders single attribute", () => {
      expect(renderAttrs({ name: "description" })).toBe('name="description"');
    });

    test("renders multiple attributes", () => {
      const result = renderAttrs({ name: "description", content: "test" });
      expect(result).toContain('name="description"');
      expect(result).toContain('content="test"');
    });

    test("filters undefined values", () => {
      expect(renderAttrs({ name: "test", content: undefined })).toBe('name="test"');
    });

    test("escapes attribute values", () => {
      expect(renderAttrs({ content: 'say "hello"' })).toBe('content="say &quot;hello&quot;"');
    });

    test("returns empty string for empty object", () => {
      expect(renderAttrs({})).toBe("");
    });

    test("returns empty string when all values are undefined", () => {
      expect(renderAttrs({ a: undefined, b: undefined })).toBe("");
    });
  });

  describe("buildMetaParts", () => {
    test("builds title tag", () => {
      const meta: MetaDescriptor[] = [{ title: "Test Page" }];
      const result = buildMetaParts(meta);
      expect(result).toContain("<title>Test Page</title>");
    });

    test("builds standard meta tags", () => {
      const meta: MetaDescriptor[] = [{ name: "description", content: "Test description" }];
      const result = buildMetaParts(meta);
      expect(result).toContain('<meta name="description" content="Test description" />');
    });

    test("builds script:ld+json", () => {
      const meta: MetaDescriptor[] = [{ "script:ld+json": { "@type": "WebPage" } }];
      const result = buildMetaParts(meta);
      expect(result[0]).toContain("application/ld+json");
      expect(result[0]).toContain('"@type":"WebPage"');
    });

    test("builds multiple parts", () => {
      const meta: MetaDescriptor[] = [{ title: "Page" }, { name: "description", content: "desc" }];
      const result = buildMetaParts(meta);
      expect(result).toHaveLength(2);
    });

    test("skips title if not present", () => {
      const meta: MetaDescriptor[] = [{ name: "description", content: "desc" }];
      const result = buildMetaParts(meta);
      expect(result.some((p) => p.includes("<title>"))).toBe(false);
    });

    test("escapes title content", () => {
      const meta: MetaDescriptor[] = [{ title: 'Test & "Quote"' }];
      const result = buildMetaParts(meta);
      expect(result).toContain("<title>Test &amp; &quot;Quote&quot;</title>");
    });
  });

  describe("buildLinkParts", () => {
    test("builds single link tag", () => {
      const links = [{ rel: "stylesheet", href: "/style.css" }];
      const result = buildLinkParts(links);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('<link rel="stylesheet" href="/style.css" />');
    });

    test("builds multiple link tags", () => {
      const links = [
        { rel: "stylesheet", href: "/style.css" },
        { rel: "icon", href: "/favicon.ico" },
      ];
      const result = buildLinkParts(links);
      expect(result).toHaveLength(2);
    });

    test("escapes attribute values", () => {
      const links = [{ rel: "stylesheet", href: "/path?foo=1&bar=2" }];
      const result = buildLinkParts(links);
      expect(result[0]).toContain("foo=1&amp;bar=2");
    });
  });

  describe("buildScriptParts", () => {
    test("builds script tag without children", () => {
      const scripts = [{ src: "/app.js" }];
      const result = buildScriptParts(scripts);
      expect(result[0]).toBe('<script src="/app.js"></script>');
    });

    test("builds script tag with children", () => {
      const scripts = [{ src: "/app.js", children: "console.log('hi');" }];
      const result = buildScriptParts(scripts);
      expect(result[0]).toBe("<script src=\"/app.js\">console.log('hi');</script>");
    });

    test("builds multiple script tags", () => {
      const scripts = [{ src: "/a.js" }, { src: "/b.js" }];
      const result = buildScriptParts(scripts);
      expect(result).toHaveLength(2);
    });

    test("handles async and defer", () => {
      const scripts = [{ src: "/app.js", async: "true", defer: "true" }];
      const result = buildScriptParts(scripts);
      expect(result[0]).toContain('async="true"');
      expect(result[0]).toContain('defer="true"');
    });
  });

  describe("buildStyleParts", () => {
    test("builds style tag without type", () => {
      const styles = [{ children: "body { margin: 0; }" }];
      const result = buildStyleParts(styles);
      expect(result[0]).toBe("<style>body { margin: 0; }</style>");
    });

    test("builds style tag with type", () => {
      const styles = [{ type: "text/css", children: "body {}" }];
      const result = buildStyleParts(styles);
      expect(result[0]).toBe('<style type="text/css">body {}</style>');
    });

    test("builds multiple style tags", () => {
      const styles = [{ children: "a {}" }, { children: "b {}" }];
      const result = buildStyleParts(styles);
      expect(result).toHaveLength(2);
    });

    test("escapes type attribute", () => {
      const styles = [{ type: 'text/css"', children: "body {}" }];
      const result = buildStyleParts(styles);
      expect(result[0]).toContain('type="text/css&quot;"');
    });
  });

  describe("buildHeadInjection", () => {
    test("builds complete head with all parts", () => {
      const headData: HeadOptions = {
        meta: [{ title: "Test" }, { name: "description", content: "Desc" }],
        links: [{ rel: "stylesheet", href: "/style.css" }],
        scripts: [{ src: "/app.js" }],
        styles: [{ children: "body {}" }],
      };

      const result = buildHeadInjection(headData);

      expect(result).toContain("<title>Test</title>");
      expect(result).toContain("description");
      expect(result).toContain("stylesheet");
      expect(result).toContain("/app.js");
      expect(result).toContain("body {}");
    });

    test("returns empty string for undefined headData", () => {
      const result = buildHeadInjection(undefined);
      expect(result).toBe("");
    });

    test("formats with newlines and indentation", () => {
      const headData: HeadOptions = {
        meta: [{ title: "Test" }],
      };
      const result = buildHeadInjection(headData);
      expect(result).toContain("\n");
    });

    test("handles empty headData object", () => {
      const result = buildHeadInjection({});
      expect(result).toBe("");
    });
  });
});
