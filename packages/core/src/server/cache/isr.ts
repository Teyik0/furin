import { allStateBuckets, type FurinInstance, instanceSlot } from "../instance.ts";
import { createHtmlRouteCache, type ISRCacheEntry } from "./isr-ssg";
import { registerCacheInvalidator } from "./registry";
import type { Cache } from "./route-cache";
import { createStoreView, type StoreView } from "./store-view";

interface ISRCacheState {
  cache: Cache<ISRCacheEntry>;
  generations: Map<string, Set<ISRCacheGeneration>>;
  pendingRevalidations: Map<string, Promise<void>>;
}

export interface ISRCacheGeneration {
  valid: boolean;
}

// Per-instance ISR HTML cache — registered against the owning instance's
// invalidator map on first access.
const instanceIsrCache = instanceSlot<ISRCacheState>((instance) => {
  const generations = new Map<string, Set<ISRCacheGeneration>>();
  const pendingRevalidations = new Map<string, Promise<void>>();
  const cache = createHtmlRouteCache<ISRCacheEntry>("isr", {
    onDelete: (key) => {
      const pending = generations.get(key);
      if (pending === undefined) {
        return;
      }
      for (const generation of pending) {
        generation.valid = false;
      }
      generations.delete(key);
    },
  });
  registerCacheInvalidator(cache, instance);
  return { cache, generations, pendingRevalidations };
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
  const state = instanceIsrCache();
  const generation = { valid: true };
  const pending = state.generations.get(key);
  if (pending === undefined) {
    state.generations.set(key, new Set([generation]));
  } else {
    pending.add(generation);
  }
  return generation;
}

export function releaseISRCacheGeneration(key: string, generation: ISRCacheGeneration): void {
  const { generations } = instanceIsrCache();
  const pending = generations.get(key);
  pending?.delete(generation);
  if (pending?.size === 0) {
    generations.delete(key);
  }
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
