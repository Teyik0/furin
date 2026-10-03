import { allStateBuckets, type FurinInstance, instanceSlot } from "../instance.ts";
import { createHtmlRouteCache, type ISRCacheEntry } from "./isr-ssg";
import { registerCacheInvalidator } from "./registry";
import type { Cache, CacheGeneration } from "./route-cache";
import { createStoreView, type StoreView } from "./store-view";

interface ISRCacheState {
  cache: Cache<ISRCacheEntry>;
  pendingRevalidations: Map<string, Promise<void>>;
}

export type ISRCacheGeneration = CacheGeneration;

// Per-instance ISR HTML cache — registered against the owning instance's
// invalidator map on first access.
const instanceIsrCache = instanceSlot<ISRCacheState>((instance) => {
  const pendingRevalidations = new Map<string, Promise<void>>();
  const cache = createHtmlRouteCache<ISRCacheEntry>("isr");
  registerCacheInvalidator(cache, instance);
  return { cache, pendingRevalidations };
});

export function isrRouteCache(instance?: FurinInstance): Cache<ISRCacheEntry> {
  return instanceIsrCache(instance).cache;
}

/** Raw store view over the current instance's ISR cache. */
export const isrCache: StoreView<ISRCacheEntry> = createStoreView(
  () => instanceIsrCache().cache.store
);

export function getISRCache(key: string): ISRCacheEntry | undefined {
  return instanceIsrCache().cache.get(key);
}

export function deleteISRCache(key: string): boolean {
  return instanceIsrCache().cache.delete(key);
}

export function setISRCache(key: string, entry: ISRCacheEntry): void {
  instanceIsrCache().cache.set(key, entry);
}

export function captureISRCacheGeneration(key: string): ISRCacheGeneration {
  return instanceIsrCache().cache.captureGeneration(key);
}

export function releaseISRCacheGeneration(key: string, generation: ISRCacheGeneration): void {
  instanceIsrCache().cache.releaseGeneration(key, generation);
}

export function setISRCacheIfGenerationUnchanged(
  key: string,
  entry: ISRCacheEntry,
  generation: ISRCacheGeneration
): boolean {
  releaseISRCacheGeneration(key, generation);
  if (!generation.valid) {
    return false;
  }
  instanceIsrCache().cache.set(key, entry);
  return true;
}

export function pendingISRRevalidations(): Map<string, Promise<void>> {
  return instanceIsrCache().pendingRevalidations;
}

export function clearPendingISRRevalidations(instance?: FurinInstance): void {
  instanceIsrCache(instance).pendingRevalidations.clear();
}

export function hasPendingISRRevalidations(): boolean {
  return allStateBuckets().some(
    (instance) => instanceIsrCache(instance).pendingRevalidations.size > 0
  );
}

export async function waitForPendingISRRevalidations(): Promise<void> {
  const pending = allStateBuckets().flatMap((instance) => [
    ...instanceIsrCache(instance).pendingRevalidations.values(),
  ]);
  if (pending.length === 0) {
    return;
  }
  await Promise.allSettled(pending);
  await Bun.sleep(1);
}
