import { statSync } from "node:fs";
import { relative } from "node:path";
import { autoInvalidateRegistry } from "../auto-invalidate/registry";
import { devGraph } from "../dev/graph.ts";
import {
  currentInstrumentationRequest,
  emitCacheInvalidated,
  emitCacheAccess as emitInstrumentationCacheAccess,
} from "../devtools/instrumentation.ts";
import { allStateBuckets, currentInstance, type FurinInstance, withInstance } from "../instance.ts";
import { registerCacheInvalidator } from "./registry";
import { createRouteCache, type RevalidateType } from "./route-cache";

export interface DevLoaderCacheEntry {
  dependencies: string[];
  generatedAt: number;
  headers: Record<string, string>;
  loaderData: Record<string, unknown>;
  mode: "isr" | "ssg";
  revalidate: number;
}

export interface InvalidateOutcome {
  cleared: string[];
  isr: number;
  ssg: number;
}

interface CacheKindHandle {
  cache: ReturnType<typeof createDevLoaderCache>;
  kind: "isr" | "ssg";
}

interface DevLoaderState {
  isr: CacheKindHandle;
  sourceFileToCacheKeys: Map<string, Set<string>>;
  ssg: CacheKindHandle;
}

function indexEntryDependencies(
  index: Map<string, Set<string>>,
  cacheKey: string,
  deps: string[]
): void {
  for (const dep of deps) {
    let bucket = index.get(dep);
    if (!bucket) {
      bucket = new Set<string>();
      index.set(dep, bucket);
    }
    bucket.add(cacheKey);
  }
}

function unindexEntryDependencies(
  index: Map<string, Set<string>>,
  cacheKey: string,
  deps: string[]
): void {
  for (const dep of deps) {
    const bucket = index.get(dep);
    if (!bucket) {
      continue;
    }
    bucket.delete(cacheKey);
    if (bucket.size === 0) {
      index.delete(dep);
    }
  }
}

function createDevLoaderCache(name: string, index: Map<string, Set<string>>) {
  return createRouteCache<DevLoaderCacheEntry>({
    name,
    onDelete: (key, entry) => {
      unindexEntryDependencies(index, key, entry.dependencies);
      const urlPath = urlPathWithSearchFromCacheKey(key);
      if (urlPath) {
        autoInvalidateRegistry.unregisterPath(urlPath);
      }
    },
    onSet: (key, entry, previous) => {
      if (previous) {
        unindexEntryDependencies(index, key, previous.dependencies);
      }
      indexEntryDependencies(index, key, entry.dependencies);
    },
    pathFromKey: urlPathFromCacheKey,
  });
}

const DEV_LOADER_STATE = Symbol.for("@teyik0/furin/dev-loader-state");

// Per-instance dev loader caches + source-dependency index are owned by the
// instance's DevGraph so module revisions and loader data share one lifetime.
function instanceDevLoaderState(instance: FurinInstance | undefined): DevLoaderState {
  const target = instance ?? currentInstance();
  const state = devGraph(target).state<DevLoaderState>(DEV_LOADER_STATE, () => {
    const sourceFileToCacheKeys = new Map<string, Set<string>>();
    const isrCache = createDevLoaderCache("render:dev-isr-loader", sourceFileToCacheKeys);
    const ssgCache = createDevLoaderCache("render:dev-ssg-loader", sourceFileToCacheKeys);
    return {
      isr: { cache: isrCache, kind: "isr" },
      sourceFileToCacheKeys,
      ssg: { cache: ssgCache, kind: "ssg" },
    };
  });
  registerCacheInvalidator(state.isr.cache, target);
  registerCacheInvalidator(state.ssg.cache, target);
  return state;
}

function emitCacheAccess(
  cache: "isr-loader" | "ssg-loader",
  key: string,
  entry: DevLoaderCacheEntry | undefined
): void {
  const request = currentInstrumentationRequest();
  const path = urlPathFromCacheKey(key);
  if (request === undefined || path === null) {
    return;
  }
  let outcome: "hit" | "miss" | "stale";
  if (entry === undefined) {
    outcome = "miss";
  } else {
    outcome = isDevLoaderCacheValid(entry) ? "hit" : "stale";
  }
  emitInstrumentationCacheAccess({
    cache,
    operationId: request.operationId,
    outcome,
    path,
    requestId: request.requestId,
  });
}

export function getDevISRLoaderCache(key: string): DevLoaderCacheEntry | undefined {
  const entry = instanceDevLoaderState(undefined).isr.cache.get(key);
  emitCacheAccess("isr-loader", key, entry);
  return entry;
}

export function setDevISRLoaderCache(key: string, entry: DevLoaderCacheEntry): void {
  instanceDevLoaderState(undefined).isr.cache.set(key, entry);
}

export function getDevSSGLoaderCache(key: string): DevLoaderCacheEntry | undefined {
  const entry = instanceDevLoaderState(undefined).ssg.cache.get(key);
  emitCacheAccess("ssg-loader", key, entry);
  return entry;
}

export function setDevSSGLoaderCache(key: string, entry: DevLoaderCacheEntry): void {
  instanceDevLoaderState(undefined).ssg.cache.set(key, entry);
}

export function urlPathFromCacheKey(key: string): string | null {
  const searchStart = key.indexOf("?");
  const keyWithoutSearch = searchStart === -1 ? key : key.slice(0, searchStart);
  const sep = keyWithoutSearch.lastIndexOf(":/");
  if (sep === -1) {
    return null;
  }
  return keyWithoutSearch.slice(sep + 1);
}

function urlPathWithSearchFromCacheKey(key: string): string | null {
  const urlPath = urlPathFromCacheKey(key);
  if (urlPath === null) {
    return null;
  }
  const searchStart = key.indexOf("?");
  if (searchStart === -1) {
    return urlPath;
  }
  return `${urlPath}${key.slice(searchStart)}`;
}

export function invalidateDevLoaderCacheByPath(
  path: string,
  type: RevalidateType
): InvalidateOutcome {
  const state = instanceDevLoaderState(undefined);
  const cleared: string[] = [];
  let isr = 0;
  let ssg = 0;

  const matches = (urlPath: string): boolean => {
    if (type === "page") {
      return urlPath === path;
    }
    const prefix = path === "/" || path.endsWith("/") ? path : `${path}/`;
    return urlPath === path || urlPath.startsWith(prefix);
  };

  for (const handle of [state.isr, state.ssg]) {
    for (const key of [...handle.cache.keys()]) {
      const urlPath = urlPathFromCacheKey(key);
      if (urlPath === null || !matches(urlPath)) {
        continue;
      }
      const entry = handle.cache.get(key);
      if (!entry) {
        continue;
      }
      handle.cache.delete(key);
      cleared.push(key);
      if (handle.kind === "isr") {
        isr += 1;
      } else {
        ssg += 1;
      }
    }
  }

  return { cleared, isr, ssg };
}

export function invalidateDevLoaderCacheBySource(filePath: string): InvalidateOutcome {
  const state = instanceDevLoaderState(undefined);
  const keys = state.sourceFileToCacheKeys.get(filePath);
  if (!keys || keys.size === 0) {
    return { cleared: [], isr: 0, ssg: 0 };
  }

  const cleared: string[] = [];
  let isr = 0;
  let ssg = 0;

  const snapshot = [...keys];
  for (const key of snapshot) {
    const isrEntry = state.isr.cache.get(key);
    if (isrEntry) {
      state.isr.cache.delete(key);
      cleared.push(key);
      isr += 1;
      continue;
    }
    const ssgEntry = state.ssg.cache.get(key);
    if (ssgEntry) {
      state.ssg.cache.delete(key);
      cleared.push(key);
      ssg += 1;
    }
  }

  const request = currentInstrumentationRequest();
  const operationId = request === undefined ? null : request.operationId;
  const requestId = request === undefined ? null : request.requestId;
  emitCacheInvalidated({
    deleted: cleared.length > 0,
    operationId,
    purgedPaths: cleared.length,
    reason: "source",
    requestId,
    target: relative(process.cwd(), filePath).replaceAll("\\", "/"),
  });
  return { cleared, isr, ssg };
}

export function isDevLoaderCacheFresh(entry: DevLoaderCacheEntry): boolean {
  return Date.now() - entry.generatedAt < entry.revalidate * 1000;
}

export function isDevLoaderCacheValid(entry: DevLoaderCacheEntry): boolean {
  if (!isDevLoaderCacheFresh(entry)) {
    return false;
  }
  for (const dep of entry.dependencies) {
    let mtimeMs: number;
    try {
      ({ mtimeMs } = statSync(dep));
    } catch {
      return false;
    }
    if (mtimeMs > entry.generatedAt) {
      return false;
    }
  }
  return true;
}

export function getAllDevISRLoaderEntries(): [string, DevLoaderCacheEntry][] {
  return [...instanceDevLoaderState(undefined).isr.cache.entries()];
}

export function getAllDevSSGLoaderEntries(): [string, DevLoaderCacheEntry][] {
  return [...instanceDevLoaderState(undefined).ssg.cache.entries()];
}

/** @internal — clears dev loader caches for `instance` (default: current). */
export function clearDevLoaderCaches(instance?: FurinInstance): void {
  const target = instance ?? currentInstance();
  const state = instanceDevLoaderState(target);
  // `.clear()` fires onDelete per entry, which unregisters the path from the
  // auto-invalidate registry via the `currentInstance()`-scoped facade — bind
  // the scope here so the unregistration hits the cleared instance's registry
  // (re-entering an already-active identical scope is harmless).
  withInstance(target, () => {
    state.isr.cache.clear();
    state.ssg.cache.clear();
  });
  state.sourceFileToCacheKeys.clear();
}

export function __resetDevLoaderCacheState(): void {
  for (const instance of allStateBuckets()) {
    clearDevLoaderCaches(instance);
  }
}
