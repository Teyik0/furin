import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";

const emittedLogs: Record<string, unknown>[] = [];

mock.module("evlog", () => ({
  createLogger: (ctx: Record<string, unknown>) => ({
    set: (data: Record<string, unknown>) => {
      Object.assign(ctx, data);
    },
    error: (err: Error) => {
      ctx.error = err;
    },
    emit: () => {
      emittedLogs.push({ ...ctx });
    },
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    info: () => {},
    // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
    warn: () => {},
    getContext: () => ctx,
    fork: (_label: string, fn: () => unknown) => fn(),
  }),
}));

mock.module("evlog/elysia", () => ({
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op stub
  useLogger: () => ({ set() {} }),
  evlog: () => (app: unknown) => app,
}));

import {
  __resetCacheState,
  consumePendingInvalidations,
  getBuildId,
  isrCache,
  revalidatePath,
  setBuildId,
  setCachePurger,
  setISRCache,
  setSSGCache,
  ssgCache,
} from "../src/render/cache";
import { __setDevMode } from "../src/runtime-env";

const _originalDevMode = process.env.NODE_ENV !== "production";

beforeAll(() => {
  __setDevMode(false);
});

afterAll(() => {
  __setDevMode(_originalDevMode);
});

afterEach(() => {
  __resetCacheState();
});

// ── Bullet 1: revalidatePath("page") evicts ISR cache ─────────────────────────

describe("revalidatePath page eviction", () => {
  test("removes an exact ISR cache entry", () => {
    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    expect(isrCache.has("/blog/post")).toBe(true);

    revalidatePath("/blog/post");

    expect(isrCache.has("/blog/post")).toBe(false);
  });

  test("returns true when a cache entry was deleted", () => {
    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    const result = revalidatePath("/blog/post");

    expect(result).toBe(true);
  });

  test("returns false when no cache entry existed", () => {
    const result = revalidatePath("/blog/nonexistent");

    expect(result).toBe(false);
  });

  test("removes an exact SSG cache entry", () => {
    setSSGCache("/about", { html: "<html>about</html>", cachedAt: Date.now() });
    expect(ssgCache.has("/about")).toBe(true);

    revalidatePath("/about");

    expect(ssgCache.has("/about")).toBe(false);
  });

  test("does not remove unrelated ISR cache entries", () => {
    setISRCache("/blog/post-1", {
      html: "<html>1</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/blog/post-2", {
      html: "<html>2</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    revalidatePath("/blog/post-1");

    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blog/post-2")).toBe(true);
  });
});

// ── Bullet 2: revalidatePath("layout") prefix-evicts ISR and SSG ──────────────

describe("revalidatePath layout prefix eviction", () => {
  test("evicts all ISR cache entries under the given prefix", () => {
    setISRCache("/blog/post-1", {
      html: "<html>1</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/blog/post-2", {
      html: "<html>2</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/other/page", {
      html: "<html>other</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    revalidatePath("/blog", "layout");

    expect(isrCache.has("/blog/post-1")).toBe(false);
    expect(isrCache.has("/blog/post-2")).toBe(false);
    expect(isrCache.has("/other/page")).toBe(true);
  });

  test("evicts SSG cache entries under the given prefix", () => {
    setSSGCache("/blog/post-1", { html: "<html>1</html>", cachedAt: Date.now() });
    setSSGCache("/blog/post-2", { html: "<html>2</html>", cachedAt: Date.now() });
    setSSGCache("/contact", { html: "<html>contact</html>", cachedAt: Date.now() });

    revalidatePath("/blog", "layout");

    expect(ssgCache.has("/blog/post-1")).toBe(false);
    expect(ssgCache.has("/blog/post-2")).toBe(false);
    expect(ssgCache.has("/contact")).toBe(true);
  });

  test("evicts the exact path itself when type is layout", () => {
    setISRCache("/blog", {
      html: "<html>blog index</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    revalidatePath("/blog", "layout");

    expect(isrCache.has("/blog")).toBe(false);
  });

  test("returns true when at least one entry was evicted", () => {
    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });

    const result = revalidatePath("/blog", "layout");

    expect(result).toBe(true);
  });

  test("returns false when no entries matched the prefix", () => {
    const result = revalidatePath("/blog", "layout");

    expect(result).toBe(false);
  });
});

// ── Bullet 3: revalidatePath queues pendingInvalidations (page) ───────────────

describe("consumePendingInvalidations after page revalidation", () => {
  test("consumePendingInvalidations returns the queued path", () => {
    revalidatePath("/blog/post");

    const paths = consumePendingInvalidations();

    expect(paths).toContain("/blog/post");
  });

  test("second call returns empty array", () => {
    revalidatePath("/blog/post");
    consumePendingInvalidations();

    const second = consumePendingInvalidations();

    expect(second).toEqual([]);
  });

  test("multiple revalidatePath calls accumulate before consume", () => {
    revalidatePath("/page-a");
    revalidatePath("/page-b");

    const paths = consumePendingInvalidations();

    expect(paths).toContain("/page-a");
    expect(paths).toContain("/page-b");
    expect(paths.length).toBe(2);
  });

  test("duplicate paths are deduplicated (Set semantics)", () => {
    revalidatePath("/blog/post");
    revalidatePath("/blog/post");

    const paths = consumePendingInvalidations();

    expect(paths.filter((p) => p === "/blog/post").length).toBe(1);
  });
});

// ── Bullet 4: revalidatePath("layout") queues "path:layout" form ──────────────

describe("consumePendingInvalidations after layout revalidation", () => {
  test("queues the path in :layout form", () => {
    revalidatePath("/blog", "layout");

    const paths = consumePendingInvalidations();

    expect(paths).toContain("/blog:layout");
  });

  test("does not queue the bare path (only the :layout form)", () => {
    revalidatePath("/blog", "layout");

    const paths = consumePendingInvalidations();

    expect(paths).not.toContain("/blog");
    expect(paths).toContain("/blog:layout");
  });

  test("second call returns empty array after consuming", () => {
    revalidatePath("/blog", "layout");
    consumePendingInvalidations();

    const second = consumePendingInvalidations();

    expect(second).toEqual([]);
  });
});

// ── Bullet 5: setCachePurger is called by revalidatePath ──────────────────────

describe("setCachePurger", () => {
  test("purger is called with the revalidated path", async () => {
    const purgedPaths: string[][] = [];
    setCachePurger((paths) => {
      purgedPaths.push(paths);
      return Promise.resolve();
    });

    setISRCache("/blog/post", {
      html: "<html>post</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    revalidatePath("/blog/post");

    // Wait a tick for the fire-and-forget async purger
    await Bun.sleep(10);

    expect(purgedPaths.length).toBeGreaterThan(0);
    expect(purgedPaths[0]).toContain("/blog/post");
  });

  test("purger is called even when no cache entry exists", async () => {
    const purgedPaths: string[][] = [];
    setCachePurger((paths) => {
      purgedPaths.push(paths);
      return Promise.resolve();
    });

    revalidatePath("/nonexistent");

    await Bun.sleep(10);

    expect(purgedPaths.length).toBeGreaterThan(0);
    expect(purgedPaths[0]).toContain("/nonexistent");
  });

  test("purger is called with layout paths when type is layout", async () => {
    const purgedPaths: string[][] = [];
    setCachePurger((paths) => {
      purgedPaths.push(paths);
      return Promise.resolve();
    });

    setISRCache("/blog/post-1", {
      html: "<html>1</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    setISRCache("/blog/post-2", {
      html: "<html>2</html>",
      generatedAt: Date.now(),
      revalidate: 60,
    });
    revalidatePath("/blog", "layout");

    await Bun.sleep(10);

    expect(purgedPaths.length).toBeGreaterThan(0);
    const allPurged = purgedPaths.flat();
    expect(allPurged).toContain("/blog/post-1");
    expect(allPurged).toContain("/blog/post-2");
  });

  test("no purger is registered — revalidatePath does not throw", () => {
    // _cachePurger is null after __resetCacheState()
    expect(() => revalidatePath("/blog/post")).not.toThrow();
  });

  test("purger errors are swallowed (fire-and-forget)", async () => {
    emittedLogs.length = 0;

    setCachePurger(() => Promise.reject(new Error("CDN unavailable")));
    revalidatePath("/blog/post");

    // Two microtask ticks: one for the rejection to settle, one for .catch() to fire.
    // Avoids yielding to a macrotask timer (setTimeout) which lets other tests interleave
    // while _cachePurger is still the rejecting function.
    await Promise.resolve();
    await Promise.resolve();

    expect(emittedLogs.length).toBeGreaterThan(0);
    expect(emittedLogs[0]).toMatchObject({
      furin: { action: "cdn_purge_failed", paths: ["/blog/post"] },
    });
    expect((emittedLogs[0] as { error?: Error }).error).toBeInstanceOf(Error);
  });
});

// ── Bullet 6: setBuildId / getBuildId round-trip ──────────────────────────────

describe("setBuildId / getBuildId", () => {
  test("round-trips the build ID", () => {
    setBuildId("abc123");
    expect(getBuildId()).toBe("abc123");
  });

  test("returns empty string before being set", () => {
    // __resetCacheState() resets _buildId to ""
    expect(getBuildId()).toBe("");
  });

  test("overwriting buildId replaces the previous value", () => {
    setBuildId("v1");
    setBuildId("v2");
    expect(getBuildId()).toBe("v2");
  });
});
