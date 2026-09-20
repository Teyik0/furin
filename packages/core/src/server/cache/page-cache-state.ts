import { type FurinInstance, instanceSlot } from "../instance.ts";
import type { PageCacheAdapter } from "./page-cache.ts";

interface PageCacheAdapterState {
  adapter: PageCacheAdapter | undefined;
}

const instancePageCacheAdapter = instanceSlot<PageCacheAdapterState>(() => ({
  adapter: undefined,
}));

export function getPageCacheAdapter(instance?: FurinInstance): PageCacheAdapter | undefined {
  return instancePageCacheAdapter(instance).adapter;
}

export function setPageCacheAdapter(instance: FurinInstance, adapter: PageCacheAdapter): void {
  instancePageCacheAdapter(instance).adapter = adapter;
}

export function resetPageCacheAdapter(instance: FurinInstance): void {
  instancePageCacheAdapter(instance).adapter = undefined;
}
