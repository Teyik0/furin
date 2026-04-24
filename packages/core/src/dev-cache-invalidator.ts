import { readdirSync, watch } from "node:fs";
import { join } from "node:path";
import { isrCache, ssgCache } from "./render/cache.ts";

/**
 * Dev-mode cache invalidator.
 *
 * Bridges Bun's workspace HMR reloads with the SSG/ISR caches.  Each rendered
 * cache entry records which source files it depends on (the page itself, every
 * `_route.tsx` layout between the page and the pages root, and `root.tsx`).
 * When one of those files is re-evaluated by the dev server, call
 * {@link invalidateDevCache} with the file path; every cache key that depended
 * on it is cleared so the next request re-renders with fresh code.
 *
 * The registry only has to contain entries we actually have cached, so the
 * memory overhead is O(distinct cache keys) — independent of route count.
 */

/** Source-file → cache-keys map. Populated on cache miss, drained on invalidation. */
const fileToCacheKeys = new Map<string, Set<string>>();

/** Inverse map kept in lockstep so we can clean up all references when a key is cleared. */
const cacheKeyToFiles = new Map<string, Set<string>>();

export interface InvalidateOutcome {
  cleared: string[];
  isr: number;
  ssg: number;
}

/**
 * Records that `cacheKey` depends on every path in `filePaths`.
 * Called by dev SSG/ISR handlers after a successful render.
 */
export function registerRouteDependencies(cacheKey: string, filePaths: string[]): void {
  const existingFiles = cacheKeyToFiles.get(cacheKey);
  if (existingFiles) {
    for (const file of existingFiles) {
      fileToCacheKeys.get(file)?.delete(cacheKey);
    }
  }
  const files = new Set(filePaths);
  cacheKeyToFiles.set(cacheKey, files);
  for (const file of files) {
    let bucket = fileToCacheKeys.get(file);
    if (!bucket) {
      bucket = new Set();
      fileToCacheKeys.set(file, bucket);
    }
    bucket.add(cacheKey);
  }
}

/**
 * Drops every cache entry that depends on `filePath`.
 * Safe to call for files that were never registered — returns an empty outcome.
 */
export function invalidateDevCache(filePath: string): InvalidateOutcome {
  const cacheKeys = fileToCacheKeys.get(filePath);
  if (!cacheKeys || cacheKeys.size === 0) {
    return { cleared: [], isr: 0, ssg: 0 };
  }

  const cleared: string[] = [];
  let ssg = 0;
  let isr = 0;

  for (const key of cacheKeys) {
    if (ssgCache.delete(key)) {
      ssg++;
    }
    if (isrCache.delete(key)) {
      isr++;
    }
    cleared.push(key);
    const files = cacheKeyToFiles.get(key);
    if (files) {
      for (const file of files) {
        fileToCacheKeys.get(file)?.delete(key);
      }
      cacheKeyToFiles.delete(key);
    }
  }

  if (cleared.length > 0) {
    console.log(
      `[furin:cache] invalidated ${cleared.length} route${cleared.length === 1 ? "" : "s"} for ${filePath} (ssg: ${ssg}, isr: ${isr})`
    );
  }

  return { cleared, isr, ssg };
}

/**
 * Starts an `fs.watch` on the pages directory so that any file edit triggers
 * {@link invalidateDevCache} for the absolute path.  Covers page files, which
 * are imported via a virtual namespace and therefore never fire the workspace
 * `onLoad` HMR hook.  Idempotent — repeat calls for the same pagesDir no-op.
 */
interface PagesWatchGroup {
  close(): void;
  watchedDirs: Set<string>;
  watchers: Map<string, ReturnType<typeof watch>>;
}

const pagesWatchers = new Map<string, PagesWatchGroup>();

function isExistingDirectory(path: string): boolean {
  try {
    return readdirSync(path, { withFileTypes: false }) !== undefined;
  } catch {
    return false;
  }
}

function watchNestedPagesDir(group: PagesWatchGroup, dir: string): void {
  if (group.watchedDirs.has(dir) || !isExistingDirectory(dir)) {
    return;
  }

  group.watchedDirs.add(dir);
  const watcher = watch(dir, (_event, filename) => {
    if (!filename) {
      return;
    }

    const changedPath = join(dir, filename.toString());
    invalidateDevCache(changedPath);
    watchNestedPagesDir(group, changedPath);
  });
  group.watchers.set(dir, watcher);

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      watchNestedPagesDir(group, join(dir, entry.name));
    }
  }
}

export function watchPagesForInvalidation(pagesDir: string): void {
  if (pagesWatchers.has(pagesDir)) {
    return;
  }

  const group: PagesWatchGroup = {
    close() {
      for (const watcher of this.watchers.values()) {
        watcher.close();
      }
      this.watchers.clear();
      this.watchedDirs.clear();
    },
    watchedDirs: new Set<string>(),
    watchers: new Map<string, ReturnType<typeof watch>>(),
  };

  watchNestedPagesDir(group, pagesDir);
  pagesWatchers.set(pagesDir, group);
}

/** @internal test-only — resets dependency registry + stops every active watcher */
export function __resetDevCacheInvalidator(): void {
  fileToCacheKeys.clear();
  cacheKeyToFiles.clear();
  for (const group of pagesWatchers.values()) {
    group.close();
  }
  pagesWatchers.clear();
}
