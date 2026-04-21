export interface ISRCacheEntry {
  generatedAt: number;
  html: string;
  revalidate: number;
}

export interface SsgCacheEntry {
  cachedAt: number;
  html: string;
  status: number;
}

/** Maximum number of ISR cache entries before LRU eviction kicks in. */
const MAX_ISR_CACHE_SIZE = 1000;
/** Maximum number of SSG cache entries before LRU eviction kicks in. */
const MAX_SSG_CACHE_SIZE = 1000;

export const isrCache = new Map<string, ISRCacheEntry>();
export const ssgCache = new Map<string, SsgCacheEntry>();

/**
 * Evicts the oldest entry from a Map when its size exceeds the given limit.
 * JS Maps maintain insertion order, so the first key is always the oldest.
 */
function evictOldest<V>(map: Map<string, V>, maxSize: number): void {
  if (map.size > maxSize) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) {
      map.delete(oldest);
    }
  }
}

/**
 * Gets an ISR cache entry and refreshes its recency so it is treated as
 * recently used by the LRU eviction policy.  Without this, a hot entry that
 * was written early would be evicted before a cold entry written later.
 */
export function getISRCache(key: string): ISRCacheEntry | undefined {
  const entry = isrCache.get(key);
  if (entry !== undefined) {
    // Re-insert at the end to mark as most-recently used
    isrCache.delete(key);
    isrCache.set(key, entry);
  }
  return entry;
}

/**
 * Gets an SSG cache entry and refreshes its recency so it is treated as
 * recently used by the LRU eviction policy.
 */
export function getSSGCache(key: string): SsgCacheEntry | undefined {
  const entry = ssgCache.get(key);
  if (entry !== undefined) {
    ssgCache.delete(key);
    ssgCache.set(key, entry);
  }
  return entry;
}

/** Sets an ISR cache entry with LRU eviction. */
export function setISRCache(key: string, entry: ISRCacheEntry): void {
  // Delete first to re-insert at the end (refresh insertion order for LRU)
  isrCache.delete(key);
  isrCache.set(key, entry);
  evictOldest(isrCache, MAX_ISR_CACHE_SIZE);
}

/** Sets an SSG cache entry with LRU eviction. */
export function setSSGCache(key: string, entry: SsgCacheEntry): void {
  ssgCache.delete(key);
  ssgCache.set(key, entry);
  evictOldest(ssgCache, MAX_SSG_CACHE_SIZE);
}

// ── Build ID ─────────────────────────────────────────────────────────────────

let _buildId = "";

/** Set once at server startup from the CompileContext. */
export function setBuildId(id: string): void {
  _buildId = id;
}

/** Returns the current deployment build ID, or empty string in dev / before set. */
export function getBuildId(): string {
  return _buildId;
}

import { AsyncLocalStorage } from "node:async_hooks";
// ── Pending invalidations (server → client bridge) ───────────────────────────
//
// Per-request scoping via AsyncLocalStorage: furin wraps each request's full
// lifecycle (handler + all hooks) inside `_requestInvalidationScope.run()` so
// that `revalidatePath()` and `consumePendingInvalidations()` share an isolated
// Set per request. The global `_globalPendingInvalidations` is a fallback for
// calls made outside a request context (e.g. scripts, tests, warmup code).
import { createLogger } from "../context-logger.ts";

const _requestInvalidationScope = new AsyncLocalStorage<Set<string>>();
const _globalPendingInvalidations = new Set<string>();

function _activeInvalidationSet(): Set<string> {
  return _requestInvalidationScope.getStore() ?? _globalPendingInvalidations;
}

/**
 * Wraps `fn` in a fresh per-request invalidation scope.
 * Call this around the entire Elysia request handle so that all lifecycle
 * hooks share an isolated invalidation Set.
 * @internal
 */
export function _runWithRequestInvalidationScope<T>(fn: () => T): T {
  return _requestInvalidationScope.run(new Set<string>(), fn);
}

/**
 * Consume and clear all pending invalidation paths for the current request.
 * Called by the Elysia `onAfterHandle` hook to populate `X-Furin-Revalidate`.
 * @internal
 */
export function consumePendingInvalidations(): string[] {
  const set = _activeInvalidationSet();
  if (set.size === 0) {
    return [];
  }
  const paths = [...set];
  set.clear();
  return paths;
}

// ── CDN purger hook ───────────────────────────────────────────────────────────

type CachePurger = (paths: string[]) => Promise<void>;
let _cachePurger: CachePurger | null = null;

/**
 * Register a CDN cache purger that will be called whenever `revalidatePath()`
 * is invoked. Intended for use by platform adapters (Vercel, Cloudflare, etc.).
 *
 * The purger is called fire-and-forget — errors are logged but do not affect
 * the HTTP response.
 *
 * @example
 * ```ts
 * // In a Vercel adapter:
 * import { setCachePurger } from "@teyik0/furin";
 * setCachePurger(async (paths) => {
 *   await fetch("https://api.vercel.com/v1/edge-cache/purge", {
 *     method: "POST",
 *     headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}` },
 *     body: JSON.stringify({ urls: paths }),
 *   });
 * });
 * ```
 */
export function setCachePurger(fn: CachePurger): void {
  _cachePurger = fn;
}

/** @internal */
export function callCachePurger(paths: string[]): void {
  if (!_cachePurger || paths.length === 0) {
    return;
  }
  _cachePurger(paths).catch((err: unknown) => {
    const logger = createLogger({});
    logger.set({
      furin: {
        action: "cdn_purge_failed",
        paths,
      },
    });
    logger.error(err instanceof Error ? err : new Error(String(err)));
    logger.emit();
  });
}

// ── revalidatePath ───────────────────────────────────────────────────────────

/**
 * Programmatically invalidate the server-side cache for a given path.
 *
 * - `type: 'page'` (default): exact URL match.
 * - `type: 'layout'`: the path itself plus all nested children (prefix match).
 *
 * Works for ISR and SSG routes. SSR routes are always fresh (no server-side
 * cache), but calling this still queues a client-side prefetch invalidation
 * via the `X-Furin-Revalidate` response header.
 *
 * If a CDN purger has been registered via `setCachePurger()`, it will also be
 * called asynchronously to purge the CDN edge cache.
 *
 * @returns `true` if at least one server-side cache entry was removed.
 *
 * @example
 * ```ts
 * // In an API route or webhook handler:
 * import { revalidatePath } from "@teyik0/furin";
 *
 * revalidatePath("/blog/my-post");            // invalidate a single page
 * revalidatePath("/blog", "layout");          // invalidate /blog + all children
 * ```
 */
export function revalidatePath(path: string, type: "page" | "layout" = "page"): boolean {
  // Queue for client-side notification via X-Furin-Revalidate header
  _activeInvalidationSet().add(type === "layout" ? `${path}:layout` : path);

  let deleted = false;

  if (type === "page") {
    deleted = isrCache.delete(path) || deleted;
    deleted = ssgCache.delete(path) || deleted;
    callCachePurger([path]);
    return deleted;
  }

  // layout: prefix match — invalidate the path itself + all nested children
  const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
  const purgedPaths: string[] = [];

  for (const key of isrCache.keys()) {
    if (key === path || key.startsWith(prefix)) {
      isrCache.delete(key);
      deleted = true;
      purgedPaths.push(key);
    }
  }
  for (const key of ssgCache.keys()) {
    if (key === path || key.startsWith(prefix)) {
      ssgCache.delete(key);
      deleted = true;
      if (!purgedPaths.includes(key)) {
        purgedPaths.push(key);
      }
    }
  }

  callCachePurger(purgedPaths.length > 0 ? purgedPaths : [path]);
  return deleted;
}

/** @internal — resets all module state between tests */
export function __resetCacheState(): void {
  isrCache.clear();
  ssgCache.clear();
  _buildId = "";
  _globalPendingInvalidations.clear();
  _cachePurger = null;
}
