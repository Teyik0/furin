// biome-ignore-all lint/performance/noBarrelFile: sync has a small public/internal surface

import { PollingSyncNotifier as PollingSyncNotifierImplementation } from "./notifier.ts";
import { furinSync as furinSyncImplementation } from "./plugin.ts";
import { createSyncChangesPlugin as createSyncChangesPluginImplementation } from "./stream.ts";

export const createSyncChangesPlugin = createSyncChangesPluginImplementation;
export const furinSync = furinSyncImplementation;
export const PollingSyncNotifier = PollingSyncNotifierImplementation;

export type PollingSyncNotifier = PollingSyncNotifierImplementation;

export type { SyncInvalidationInput } from "../auto-invalidate/types.ts";
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
export type { SyncInput, SyncRouteOption } from "./plugin.ts";
export type { SyncChangePage } from "./stream.ts";
