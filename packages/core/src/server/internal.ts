import type { AnyElysia } from "elysia";
import type { SsgCacheEntry } from "./cache/index.ts";
import { __clearInstanceRegistry } from "./instance.ts";

// ── Compile-time context for compiled binaries ──────────────────────────────
// The generated compile entry calls `__setCompileContext()` before importing
// server.ts. At runtime, `router.ts` and `furin.ts` use `getCompileContext()`
// to resolve modules and assets from the binary instead of the filesystem.

export interface EmbeddedAppData {
  assets: Record<string, string>;
  template: string;
}

export interface CompileContextRoute {
  mode: "ssr" | "ssg" | "isr";
  path: string;
  pattern: string;
}

export interface CompileContext {
  buildId?: string;
  /** Whether the emitted hydration client sends browser log batches. */
  clientLogging?: boolean;
  embedded?: EmbeddedAppData;
  modules: Record<string, unknown>;
  /** Elysia-native route tree generated for this mounted app. */
  nativeRoutes?: AnyElysia;
  /** Mount prefix this app was built for (`""` = root). */
  prefix?: string;
  /** Root-level conventions discovered at compile time. */
  rootConventions?: { errorPath?: string; notFoundPath?: string };
  rootPath: string;
  /** Per-route metadata including pre-computed segment boundaries. */
  routeMetadata?: Record<
    string,
    {
      segmentBoundaries: Array<{
        depth: number;
        path: string;
        errorPath?: string;
        notFoundPath?: string;
      }>;
    }
  >;
  routes: CompileContextRoute[];
  ssgCache?: Record<string, SsgCacheEntry>;
}

// Contexts are keyed by (pagesDir, prefix) — pagesDir being the directory
// containing root.tsx, normalized to posix separators. The SAME pagesDir may
// legally be mounted under two different prefixes (assertPrefixAvailable only
// rejects same-prefix collisions), so pagesDir alone would let the second
// registration overwrite the first. Several packaged furin apps can each ship
// a self-registering module calling `__setCompileContext()` — registration is
// ADDITIVE, one context per (app, mount).
const _compileContexts = new Map<string, CompileContext>();

function normalizeContextKey(path: string): string {
  return path.replaceAll("\\", "/");
}

function pagesDirOf(ctx: CompileContext): string {
  const rootPath = normalizeContextKey(ctx.rootPath);
  const lastSlash = rootPath.lastIndexOf("/");
  return lastSlash === -1 ? rootPath : rootPath.slice(0, lastSlash);
}

// "\u0000" cannot appear in a path or a prefix, so the composite key is
// unambiguous even for pagesDirs containing spaces.
function contextKey(pagesDir: string, prefix: string): string {
  return `${pagesDir}\u0000${prefix}`;
}

export function __setCompileContext(ctx: CompileContext): void {
  _compileContexts.set(contextKey(pagesDirOf(ctx), ctx.prefix ?? ""), ctx);
}

/**
 * Looks up the compile context for a (pagesDir, prefix) mount. Resolution
 * order, from most to least specific:
 * 1. exact (pagesDir, prefix) key — distinguishes the same app mounted twice;
 * 2. sole context registered for `pagesDir` — callers that don't pass a
 *    prefix, and contexts emitted before the prefix field existed;
 * 3. sole context registered for `prefix` — deployed binaries run from a
 *    different cwd than the build, so the absolute pagesDir key misses there,
 *    but the mount prefix is stable across machines;
 * 4. the sole registered context (single-app back-compat).
 */
export function getCompileContext(pagesDir?: string, prefix?: string): CompileContext | null {
  if (pagesDir !== undefined) {
    const dir = normalizeContextKey(pagesDir);
    if (prefix !== undefined) {
      const exact = _compileContexts.get(contextKey(dir, prefix));
      if (exact) {
        return exact;
      }
    }
    const dirMatch = soleContextForPagesDir(dir);
    if (dirMatch) {
      return dirMatch;
    }
  }
  if (prefix !== undefined) {
    const prefixMatch = contextForPrefix(prefix);
    if (prefixMatch) {
      return prefixMatch;
    }
  }
  if (_compileContexts.size === 1) {
    return _compileContexts.values().next().value ?? null;
  }
  return null;
}

/**
 * The sole context registered for `dir`, or null when none matches — or when
 * SEVERAL do (the same pagesDir mounted at two prefixes): guessing there
 * would hand one mount the other's assets/build ID.
 */
function soleContextForPagesDir(dir: string): CompileContext | null {
  let match: CompileContext | null = null;
  for (const ctx of _compileContexts.values()) {
    if (pagesDirOf(ctx) !== dir) {
      continue;
    }
    if (match) {
      return null;
    }
    match = ctx;
  }
  return match;
}

function contextForPrefix(prefix: string): CompileContext | null {
  for (const ctx of _compileContexts.values()) {
    if ((ctx.prefix ?? "") === prefix) {
      return ctx;
    }
  }
  return null;
}

/** All registered contexts, keyed by the composite (pagesDir, prefix) key. */
export function getAllCompileContexts(): ReadonlyMap<string, CompileContext> {
  return _compileContexts;
}

export function __resetCompileContext(): void {
  _compileContexts.clear();
  // A test tearing down compile contexts is tearing down its furin mounts —
  // forget their prefix registrations too so the next test mounts cleanly.
  __clearInstanceRegistry();
}
