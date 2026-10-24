import type { Context } from "elysia";
import { currentInstance } from "../instance.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";

const SYNC_DEFAULT_PATH = "/_furin/sync";

export interface FurinSyncOptions extends SyncRuntimeOptions {
  /** Optional application-owned validity of an authenticated event connection. */
  connection?: (
    context: Context
  ) => SyncConnectionLease | undefined | Promise<SyncConnectionLease | undefined>;
  path?: string;
}

export interface SyncConnectionLease {
  release: () => void;
  signal: AbortSignal;
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
  return {
    adapter: sync.adapter,
    notifier: sync.notifier,
    principal: sync.principal,
    secret: sync.secret,
  };
}
