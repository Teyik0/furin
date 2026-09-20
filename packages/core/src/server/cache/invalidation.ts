import { physicalPath } from "../../shared/prefix.ts";
import {
  currentInstrumentationRequest,
  emitCacheInvalidated,
} from "../devtools/instrumentation.ts";
import {
  __clearInstanceRegistry,
  allInstances,
  allStateBuckets,
  currentInstance,
  type FurinInstance,
  requestPendingInvalidations,
  runWithInstanceScope,
  withInstance,
} from "../instance.ts";
import { clearPprRouteCache } from "../render/ppr-route.ts";
import { IS_DEV } from "../runtime-env.ts";
import { clearDevLoaderCaches } from "./dev-loader";
import { clearPendingISRRevalidations, isrRouteCache } from "./isr";
import { getPageCacheAdapter, resetPageCacheAdapter } from "./page-cache-state.ts";
import {
  type CachePurger,
  setCachePurger as installPurger,
  callCachePurger as purgePaths,
  resetCachePurgers,
} from "./purger.ts";
import { getCacheInvalidators } from "./registry";
import type { RevalidateType } from "./route-cache";
import { ssgRouteCache } from "./ssg";

// ── Pending invalidations (server → client bridge) ───────────────────────────
// The per-request set lives in the instance request scope (see instance.ts);
// outside a request scope invalidations accumulate in a process-global set.

const _globalPendingInvalidations = new Set<string>();

function _activeInvalidationSet(): Set<string> {
  return requestPendingInvalidations() ?? _globalPendingInvalidations;
}

export function _runWithRequestInvalidationScope<T>(fn: () => T): T {
  return runWithInstanceScope(currentInstance(), fn);
}

export function consumePendingInvalidations(): string[] {
  const set = _activeInvalidationSet();
  if (set.size === 0) {
    return [];
  }
  const paths = [...set];
  set.clear();
  return paths;
}

export function peekPendingInvalidations(): string[] {
  return [..._activeInvalidationSet()];
}

// ── CDN purger hook ───────────────────────────────────────────────────────────
// Process-global on purpose: the CDN sits in front of every mounted app.

export function setCachePurger(fn: CachePurger): void {
  installPurger(fn);
}

export function callCachePurger(paths: string[]): void {
  purgePaths(paths);
}

// ── revalidatePath ───────────────────────────────────────────────────────────

function emitPathInvalidation(
  instance: FurinInstance,
  path: string,
  deleted: boolean,
  purgedPaths: readonly string[]
): void {
  if (!IS_DEV) {
    return;
  }
  withInstance(instance, () => {
    const request = currentInstrumentationRequest();
    emitCacheInvalidated({
      deleted,
      operationId: request?.operationId ?? null,
      purgedPaths: new Set(purgedPaths).size,
      reason: "path",
      requestId: request?.requestId ?? null,
      target: path,
    });
  });
}

async function invalidateInstancePath(
  instance: FurinInstance,
  path: string,
  type: RevalidateType
): Promise<{ deleted: boolean; purgedPaths: string[] }> {
  const result = revalidatePathForInstance(instance, path, type, false);
  const purgedPaths = [physicalPath(instance.prefix, path)];
  for (const purged of result.purgedPaths) {
    purgedPaths.push(physicalPath(instance.prefix, purged));
  }
  const pageCache = getPageCacheAdapter(instance);
  if (pageCache === undefined) {
    emitPathInvalidation(instance, path, result.deleted, purgedPaths);
    return { deleted: result.deleted, purgedPaths };
  }
  const sharedResult = await pageCache.invalidate({
    kind: "path",
    path,
    scope: instance.prefix,
    type,
  });
  for (const purged of sharedResult.paths) {
    purgedPaths.push(physicalPath(instance.prefix, purged));
  }
  const deleted = result.deleted || sharedResult.invalidated;
  emitPathInvalidation(instance, path, deleted, purgedPaths);
  return { deleted, purgedPaths };
}

/**
 * Invalidates `path` across EVERY mounted furin instance — paths are logical
 * (unprefixed), and with shared data two apps can legitimately render the same
 * logical path. This mirrors the historical shared-cache behaviour. Each
 * instance's invalidation runs inside its own scope so cache `onDelete` hooks
 * (auto-invalidate unregistration) hit the owning instance's registry.
 */
export async function revalidatePath(path: string, type: RevalidateType): Promise<boolean> {
  let deleted = false;
  const purgedPaths: string[] = [];
  const results = await Promise.all(
    allInstances().map((instance) => invalidateInstancePath(instance, path, type))
  );
  for (const result of results) {
    deleted = result.deleted || deleted;
    purgedPaths.push(...result.purgedPaths);
  }

  callCachePurger(dedupePaths(purgedPaths));
  return deleted;
}

/**
 * Invalidates `path` against a SINGLE instance's caches. `revalidateTag` uses
 * this because it knows which instance registered each path — the cross-app
 * fan-out of `revalidatePath` would also evict a sibling app's unrelated page
 * that merely shares the pathname. Does NOT call the CDN purger; callers
 * batch the returned `purgedPaths` themselves.
 */
export function revalidatePathForInstance(
  instance: FurinInstance,
  path: string,
  type: RevalidateType,
  emitPathEvent?: boolean
): { deleted: boolean; purgedPaths: string[] } {
  _activeInvalidationSet().add(type === "layout" ? `${path}:layout` : path);

  let deleted = false;
  const purgedPaths: string[] = [];
  withInstance(instance, () => {
    for (const invalidator of getCacheInvalidators(instance)) {
      const result = invalidator.invalidatePath(path, type);
      deleted = result.deleted || deleted;
      purgedPaths.push(...result.purgedPaths);
    }
    if (IS_DEV && emitPathEvent !== false) {
      emitPathInvalidation(instance, path, deleted, purgedPaths);
    }
  });
  return { deleted, purgedPaths };
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)];
}

/** @internal — resets all module state between tests */
export function __resetCacheState(): void {
  for (const instance of allStateBuckets()) {
    // `.clear()` fires each entry's onDelete hook, and those hooks resolve
    // the auto-invalidate registry via `currentInstance()` — scope to the
    // bucket being cleared so unregistrations hit ITS registry instead of
    // the ambient (default) one.
    withInstance(instance, () => {
      isrRouteCache(instance).clear();
      ssgRouteCache(instance).clear();
      clearDevLoaderCaches(instance);
      clearPprRouteCache(instance);
      clearPendingISRRevalidations(instance);
      resetPageCacheAdapter(instance);
    });
    instance.buildId = "";
  }
  // Forget mounted instances (fresh furin() calls between tests must not hit
  // prefix collisions) but keep the default bucket — cache slots above are
  // cleared, while process-wide defaults like a beforeAll template survive.
  __clearInstanceRegistry();
  _globalPendingInvalidations.clear();
  resetCachePurgers();
}
