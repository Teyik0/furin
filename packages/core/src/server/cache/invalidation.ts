import { encodeInvalidationEntry } from "../../shared/invalidation-header.ts";
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
  withInstance,
} from "../instance.ts";
import { clearMixedPublicCache } from "../render/mixed-cache.ts";
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
// The per-request set lives in the request scope (see instance.ts). Outside a
// request there is no response to report them on, so nothing is recorded.

/** @internal test helper — runs `fn` with its own pending-invalidation set. */
export function _runWithRequestInvalidationScope<T>(fn: () => T): T {
  return withInstance(currentInstance(), fn);
}

export function consumePendingInvalidations(): string[] {
  const set = requestPendingInvalidations();
  if (set === undefined || set.size === 0) {
    return [];
  }
  const paths = [...set];
  set.clear();
  return paths;
}

export function peekPendingInvalidations(): string[] {
  return [...(requestPendingInvalidations() ?? [])];
}

// ── CDN purger hook ───────────────────────────────────────────────────────────
// `furin({ cachePurger })` scopes a purger to one runtime; this process-wide
// one remains the fallback for runtimes without their own.

export function setCachePurger(fn: CachePurger): void {
  installPurger(fn);
}

export function callCachePurger(purges: ReadonlyMap<FurinInstance, readonly string[]>): void {
  purgePaths(purges);
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
  const instances = allInstances();
  const results = await Promise.all(
    instances.map((instance) => invalidateInstancePath(instance, path, type))
  );
  callCachePurger(
    new Map(instances.map((instance, index) => [instance, results[index]?.purgedPaths ?? []]))
  );
  return results.some((result) => result.deleted);
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
  requestPendingInvalidations()?.add(encodeInvalidationEntry(path, type));

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
      clearMixedPublicCache(instance);
      clearPendingISRRevalidations(instance);
      resetPageCacheAdapter(instance);
    });
    instance.buildId = "";
  }
  // Forget mounted instances (fresh furin() calls between tests must not hit
  // prefix collisions) but keep the default bucket — cache slots above are
  // cleared, while process-wide defaults like a beforeAll template survive.
  resetCachePurgers(allStateBuckets());
  __clearInstanceRegistry();
}
