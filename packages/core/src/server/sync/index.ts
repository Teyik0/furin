// biome-ignore-all lint/performance/noBarrelFile: sync has a small public/internal surface

import { invalidateSync as invalidateSyncImplementation } from "./invalidate-sync.ts";
import { PollingSyncNotifier as PollingSyncNotifierImplementation } from "./notifier.ts";
import { furinSync as furinSyncImplementation } from "./plugin.ts";
import { createSyncChangesPlugin as createSyncChangesPluginImplementation } from "./stream.ts";

export const createSyncChangesPlugin = createSyncChangesPluginImplementation;
export type { SyncConnectionLease } from "./config.ts";
export { createLocalSyncClient, type LocalSyncClientOptions } from "./local-client.ts";
export const furinSync = furinSyncImplementation;
export const invalidateSync = invalidateSyncImplementation;
export type { SyncInvalidationOptions } from "./invalidate-sync.ts";
export const PollingSyncNotifier = PollingSyncNotifierImplementation;

export type PollingSyncNotifier = PollingSyncNotifierImplementation;

export type {
  AtomicMutationResult,
  AtomicMutationValue,
  BeginMutationInput,
  BeginMutationResult,
  ChangePage,
  CompleteMutationInput,
  CompleteMutationResult,
  MutationLease,
  ReadChangesInput,
  StoredResponse,
  SyncAdapter,
  SyncChange,
  SyncInvalidation,
  SyncMutation,
  SyncNotifier,
  SyncRuntimeOptions,
  SyncSubscription,
  SyncTransaction,
  TransactionalSyncAdapter,
} from "./adapter.ts";
export type { FurinSyncOption, FurinSyncOptions } from "./config.ts";
export type { SyncChangePage } from "./stream.ts";
