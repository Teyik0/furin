import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModuleVersion, getTransformedModule } from "../../src/hmr/watcher";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Reset all HMR global state between tests so they are fully isolated.
 * watcher.ts initialises these globals on module load, so after the first
 * import they exist — we just need to clear/recreate them here.
 */
function resetHmrState(): void {
  globalThis.__elysionModuleCache = new Map();
  globalThis.__elysionModuleVersions = new Map();
  globalThis.__elysionHmrClients ??= new Set();
  globalThis.__elysionHmrWatchers ??= [];
}

/** Write a .tsx file inside the temp pages directory and return its full path. */
async function writePage(name: string, content: string): Promise<string> {
  const filePath = join(PAGES_DIR, name);
  await Bun.write(filePath, content);
  return filePath;
}

// ---------------------------------------------------------------------------
// Temp directory setup
// A fresh directory tree is created before each test and torn down after.
// ---------------------------------------------------------------------------
const TMP_BASE = join(tmpdir(), "elysion-watcher-tests");
const SRC_DIR = TMP_BASE;
const PAGES_DIR = join(TMP_BASE, "pages");

beforeEach(() => {
  mkdirSync(PAGES_DIR, { recursive: true });
  resetHmrState();
});

afterEach(() => {
  resetHmrState();
  try {
    rmSync(TMP_BASE, { recursive: true, force: true });
  } catch {
    // Cleanup errors don't fail the test
  }
});

// ---------------------------------------------------------------------------
// getModuleVersion
// Tracks how many times a file has been invalidated since the server started.
// ---------------------------------------------------------------------------
describe("getModuleVersion", () => {
  test("returns 0 for a path that has never been seen", () => {
    expect(getModuleVersion("/nonexistent/file.tsx")).toBe(0);
  });

  test("reflects a version manually set in global state", () => {
    const path = "/fake/file.tsx";
    globalThis.__elysionModuleVersions.set(path, 7);
    expect(getModuleVersion(path)).toBe(7);
  });

  test("returns 0 after global state is reset", () => {
    const path = "/fake/file.tsx";
    globalThis.__elysionModuleVersions.set(path, 4);
    resetHmrState();
    expect(getModuleVersion(path)).toBe(0);
  });

  test("returns independent versions for different paths", () => {
    globalThis.__elysionModuleVersions.set("/a.tsx", 1);
    globalThis.__elysionModuleVersions.set("/b.tsx", 99);
    expect(getModuleVersion("/a.tsx")).toBe(1);
    expect(getModuleVersion("/b.tsx")).toBe(99);
  });
});

// ---------------------------------------------------------------------------
// getTransformedModule — cache behaviour
// The cache is the primary performance path.  Its correctness is critical:
//   - a miss must transform and store
//   - a hit must return the stored value without re-transforming
//   - after invalidation a miss must re-transform
// ---------------------------------------------------------------------------
describe("getTransformedModule — cache behaviour", () => {
  test("transforms a real file and returns a non-empty JS string", async () => {
    const filePath = await writePage("index.tsx", `export const App = () => null;`);
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  test("stores the result in the module cache on first call", async () => {
    const filePath = await writePage("store.tsx", `export const x = 1;`);
    await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(globalThis.__elysionModuleCache.has(filePath)).toBe(true);
  });

  test("returns the same string on a second call (cache hit)", async () => {
    const filePath = await writePage("double.tsx", `export const x = 1;`);
    const first = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    const second = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    // Strict reference equality — not just content equality
    expect(first).toBe(second);
  });

  test("re-transforms after the cache entry is removed", async () => {
    const filePath = await writePage("evict.tsx", `export const x = 1;`);
    await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);

    globalThis.__elysionModuleCache.delete(filePath);
    expect(globalThis.__elysionModuleCache.has(filePath)).toBe(false);

    const second = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    // Same source → same output content, and the cache is repopulated
    expect(typeof second).toBe("string");
    expect(second).toContain("$RefreshReg$");
    expect(globalThis.__elysionModuleCache.has(filePath)).toBe(true);
  });

  test("cache entry includes a timestamp", async () => {
    const before = Date.now();
    const filePath = await writePage("ts.tsx", `export const x = 1;`);
    await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    const after = Date.now();

    const entry = globalThis.__elysionModuleCache.get(filePath);
    expect(entry).toBeDefined();
    expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry!.timestamp).toBeLessThanOrEqual(after);
  });
});

// ---------------------------------------------------------------------------
// getTransformedModule — output content
// The transformed code must satisfy the contracts the client runtime expects.
// ---------------------------------------------------------------------------
describe("getTransformedModule — output content", () => {
  test("output contains the HMR $RefreshReg$ wrapper", async () => {
    const filePath = await writePage("hmr.tsx", `export const App = () => null;`);
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(result).toContain("$RefreshReg$");
  });

  test("output contains injected globals (window.React)", async () => {
    const filePath = await writePage("globals.tsx", `export const x = 1;`);
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    expect(result).toContain("window.React");
  });

  test("module ID in output is derived from the path relative to srcDir", async () => {
    const filePath = await writePage("about.tsx", `export const x = 1;`);
    const result = await getTransformedModule(filePath, SRC_DIR, PAGES_DIR);
    // srcDir = TMP_BASE, file = TMP_BASE/pages/about.tsx
    // relative path from srcDir = pages/about.tsx
    // expected module ID = /_modules/src/pages/about.tsx
    expect(result).toContain("/_modules/src/pages/about.tsx");
  });
});

// ---------------------------------------------------------------------------
// getTransformedModule — error cases
// ---------------------------------------------------------------------------
describe("getTransformedModule — error cases", () => {
  test("throws with a descriptive message for a missing file", async () => {
    await expect(
      getTransformedModule("/nonexistent/file.tsx", SRC_DIR, PAGES_DIR)
    ).rejects.toThrow("File not found");
  });
});
