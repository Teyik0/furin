import { currentInstance } from "../instance.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";

const SYNC_DEFAULT_PATH = "/_furin/sync";

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
  return currentInstance().syncPath;
}

export function syncRuntimeOptions(sync: FurinSyncOptions): SyncRuntimeOptions {
  return { adapter: sync.adapter, notifier: sync.notifier, principal: sync.principal };
}
