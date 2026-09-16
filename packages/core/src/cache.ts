import {
  getCache as getRuntimeCache,
  type RuntimeCache as RuntimeCacheContract,
  type RuntimeCacheOptions as RuntimeCacheOptionsContract,
  type RuntimeCacheSetOptions as RuntimeCacheSetOptionsContract,
} from "./server/cache/runtime-cache.ts";

export type RuntimeCache = RuntimeCacheContract;
export type RuntimeCacheOptions = RuntimeCacheOptionsContract;
export type RuntimeCacheSetOptions = RuntimeCacheSetOptionsContract;

export function getCache(options?: RuntimeCacheOptions): RuntimeCache {
  return getRuntimeCache(options);
}
