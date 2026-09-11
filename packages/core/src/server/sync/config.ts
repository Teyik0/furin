import { AsyncLocalStorage } from "node:async_hooks";
import { currentInstance } from "../instance.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";

const SYNC_DEFAULT_PATH = "/_furin/sync";

// Explicit override scope (tests, synthetic renders). When unset, the sync
// path comes from the current furin instance.
const requestSyncPath = new AsyncLocalStorage<string | undefined>();

export interface FurinSyncOptions extends SyncRuntimeOptions {
  path?: string;
}

export type FurinSyncOption = FurinSyncOptions | false;

export function resolveSyncPath(sync: FurinSyncOption | undefined): string | undefined {
  if (!sync) {
    return;
  }
  return sync.path ?? SYNC_DEFAULT_PATH;
}

/**
 * Logical (unprefixed) sync path for the current request — injected
 * into rendered HTML; the client prepends its own basePath before connecting.
 */
export function getSyncPath(): string | undefined {
  const override = requestSyncPath.getStore();
  if (override !== undefined) {
    return override;
  }
  return currentInstance().syncPath;
}

export function runWithSyncPath<T>(path: string | undefined, fn: () => T): T {
  return requestSyncPath.run(path, fn);
}

export function syncRuntimeOptions(sync: FurinSyncOptions): SyncRuntimeOptions {
  return { adapter: sync.adapter, notifier: sync.notifier, principal: sync.principal };
}
