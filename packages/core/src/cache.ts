import {
  getCache as getRuntimeCache,
  type RuntimeCache as RuntimeCacheContract,
  type RuntimeCacheOptions as RuntimeCacheOptionsContract,
  type RuntimeCacheSetOptions as RuntimeCacheSetOptionsContract,
} from "./server/cache/runtime-cache.ts";

// biome-ignore lint/performance/noBarrelFile: this is the intentional public cache entrypoint.
export {
  createMemoryPageCache,
  type PageCacheAdapter,
  type PageCacheEntry,
  type PageCacheIdentity,
  type PageCacheInvalidation,
  type PageCacheInvalidationResult,
  type PageCacheLease,
  type PageCacheMode,
} from "./server/cache/page-cache.ts";

export type RuntimeCache = RuntimeCacheContract;
export type RuntimeCacheOptions = RuntimeCacheOptionsContract;
export type RuntimeCacheSetOptions = RuntimeCacheSetOptionsContract;

export function getCache(options?: RuntimeCacheOptions): RuntimeCache {
  return getRuntimeCache(options);
}
