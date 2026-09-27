import { autoInvalidateRegistry } from "../auto-invalidate/registry";
import { type FurinInstance, instanceSlot } from "../instance.ts";
import { createHtmlRouteCache, type SsgCacheEntry } from "./isr-ssg";
import { registerCacheInvalidator } from "./registry";
import type { Cache } from "./route-cache";
import { createStoreView, type StoreView } from "./store-view";

// Per-instance SSG HTML cache — registered against the owning instance's
// invalidator map on first access.
const instanceSsgCache = instanceSlot((instance) => {
  const cache = createHtmlRouteCache<SsgCacheEntry>("ssg");
  registerCacheInvalidator(cache, instance);
  return cache;
});

export function ssgRouteCache(instance?: FurinInstance): Cache<SsgCacheEntry> {
  return instanceSsgCache(instance);
}

/** Raw store view over the current instance's SSG cache. */
export const ssgCache: StoreView<SsgCacheEntry> = createStoreView(() => instanceSsgCache().store);

export function getSSGCache(key: string): SsgCacheEntry | undefined {
  return instanceSsgCache().get(key);
}

export function setSSGCache(key: string, entry: SsgCacheEntry): void {
  instanceSsgCache().set(key, entry);
  autoInvalidateRegistry.registerLoaderTags(key, entry.tags, "render:ssg-html");
}
