import { describe, expect, test } from "bun:test";
import { consumePendingInvalidations, isrCache, revalidatePath, ssgCache } from "../src/render/cache";

// ── applyRevalidateHeader (inline — same logic as in link.tsx, tested without React dep) ────────

/**
 * Local copy of the parsing logic from link.tsx's applyRevalidateHeader.
 * Kept in sync with the source; tested here to avoid the React import.
 */
function applyRevalidateHeader(
  headers: Headers,
  invalidate: (path: string, type?: "page" | "layout") => void
): void {
  const header = headers.get("x-furin-revalidate");
  if (!header) return;
  for (const entry of header.split(",")) {
    if (entry.endsWith(":layout")) {
      invalidate(entry.slice(0, -7), "layout");
    } else {
      invalidate(entry, "page");
    }
  }
}

function makeHeaders(value?: string): Headers {
  const h = new Headers();
  if (value !== undefined) h.set("x-furin-revalidate", value);
  return h;
}

describe("applyRevalidateHeader", () => {
  test("does nothing when header is absent", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders(), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([]);
  });

  test("calls invalidate for a single page path", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/blog/post-1"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/blog/post-1", "page"]]);
  });

  test("calls invalidate with 'layout' type when entry ends with :layout", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/blog:layout"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/blog", "layout"]]);
  });

  test("handles multiple comma-separated entries", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/a,/b,/c"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/a", "page"], ["/b", "page"], ["/c", "page"]]);
  });

  test("handles mixed page and layout entries", () => {
    const calls: Array<[string, string?]> = [];
    applyRevalidateHeader(makeHeaders("/blog/post-1,/blog:layout"), (p, t) => calls.push([p, t]));
    expect(calls).toEqual([["/blog/post-1", "page"], ["/blog", "layout"]]);
  });
});

function seedCaches() {
  isrCache.set("/blog/post-1", { html: "<html>post-1</html>", generatedAt: Date.now(), revalidate: 60 });
  isrCache.set("/blog/post-2", { html: "<html>post-2</html>", generatedAt: Date.now(), revalidate: 60 });
  isrCache.set("/about", { html: "<html>about</html>", generatedAt: Date.now(), revalidate: 60 });
  ssgCache.set("/blog/post-1", "<html>ssg-post-1</html>");
  ssgCache.set("/blog/post-2", "<html>ssg-post-2</html>");
  ssgCache.set("/about", "<html>ssg-about</html>");
}

function clearAll() {
  isrCache.clear();
  ssgCache.clear();
  consumePendingInvalidations();
}

// ── revalidatePath ─────────────────────────────────────────────────────────────

describe("revalidatePath", () => {
  test("returns false when path is not in either cache", () => {
    clearAll();
    expect(revalidatePath("/not-cached")).toBe(false);
  });

  test("deletes an ISR cache entry and returns true", () => {
    clearAll();
    isrCache.set("/my-page", { html: "<html/>", generatedAt: Date.now(), revalidate: 60 });
    expect(revalidatePath("/my-page")).toBe(true);
    expect(isrCache.has("/my-page")).toBe(false);
  });

  test("deletes an SSG cache entry and returns true", () => {
    clearAll();
    ssgCache.set("/my-page", "<html/>");
    expect(revalidatePath("/my-page")).toBe(true);
    expect(ssgCache.has("/my-page")).toBe(false);
  });

  test("type='page' — only removes the exact path, leaves siblings untouched", () => {
    clearAll();
    seedCaches();
    revalidatePath("/blog/post-1", "page");
    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blog/post-2")).toBe(true);
    expect(isrCache.has("/about")).toBe(true);
    expect(ssgCache.has("/blog/post-1")).toBe(false);
    expect(ssgCache.has("/blog/post-2")).toBe(true);
  });

  test("type='layout' — removes path + all children from isrCache", () => {
    clearAll();
    seedCaches();
    revalidatePath("/blog", "layout");
    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blog/post-2")).toBe(false);
    expect(isrCache.has("/about")).toBe(true);
  });

  test("type='layout' — removes path + all children from ssgCache", () => {
    clearAll();
    seedCaches();
    revalidatePath("/blog", "layout");
    expect(ssgCache.has("/blog/post-1")).toBe(false);
    expect(ssgCache.has("/blog/post-2")).toBe(false);
    expect(ssgCache.has("/about")).toBe(true);
  });

  test("type='layout' does not remove paths that share a prefix but are not children (/blogging)", () => {
    clearAll();
    isrCache.set("/blog/post-1", { html: "<html/>", generatedAt: Date.now(), revalidate: 60 });
    isrCache.set("/blogging", { html: "<html/>", generatedAt: Date.now(), revalidate: 60 });
    revalidatePath("/blog", "layout");
    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blogging")).toBe(true); // /blogging !== /blog/*
  });

  test("type='layout' with '/' — clears all entries from both caches", () => {
    clearAll();
    seedCaches();
    revalidatePath("/", "layout");
    expect(isrCache.size).toBe(0);
    expect(ssgCache.size).toBe(0);
  });
});

// ── consumePendingInvalidations ────────────────────────────────────────────────

describe("consumePendingInvalidations", () => {
  test("returns empty array when nothing was queued", () => {
    clearAll();
    expect(consumePendingInvalidations()).toEqual([]);
  });

  test("revalidatePath type='page' queues the path", () => {
    clearAll();
    revalidatePath("/my-page");
    const pending = consumePendingInvalidations();
    expect(pending).toContain("/my-page");
  });

  test("revalidatePath type='layout' queues the path with :layout suffix", () => {
    clearAll();
    revalidatePath("/blog", "layout");
    const pending = consumePendingInvalidations();
    expect(pending).toContain("/blog:layout");
  });

  test("clears the queue after calling", () => {
    clearAll();
    revalidatePath("/x");
    consumePendingInvalidations();
    expect(consumePendingInvalidations()).toEqual([]);
  });

  test("queues multiple paths from multiple calls", () => {
    clearAll();
    revalidatePath("/a");
    revalidatePath("/b", "layout");
    const pending = consumePendingInvalidations();
    expect(pending).toContain("/a");
    expect(pending).toContain("/b:layout");
  });

  test("queues path even for SSR routes (no cache entry)", () => {
    clearAll();
    // SSR route — revalidatePath returns false but still queues for client notification
    const result = revalidatePath("/ssr-page");
    expect(result).toBe(false);
    const pending = consumePendingInvalidations();
    expect(pending).toContain("/ssr-page");
  });
});
