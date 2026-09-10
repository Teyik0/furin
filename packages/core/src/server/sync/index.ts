// biome-ignore-all lint/performance/noBarrelFile: sync has a small public/internal surface

import {
  getSyncPath as getSyncPathImplementation,
  resolveSyncPath as resolveSyncPathImplementation,
  runWithSyncPath as runWithSyncPathImplementation,
} from "./config.ts";
import { PollingSyncNotifier as PollingSyncNotifierImplementation } from "./notifier.ts";
import { furinSync as furinSyncImplementation } from "./plugin.ts";
import { createSyncChangesPlugin as createSyncChangesPluginImplementation } from "./stream.ts";

export const createSyncChangesPlugin = createSyncChangesPluginImplementation;
export const furinSync = furinSyncImplementation;
export const getSyncPath = getSyncPathImplementation;
export const PollingSyncNotifier = PollingSyncNotifierImplementation;
export const resolveSyncPath = resolveSyncPathImplementation;
export const runWithSyncPath = runWithSyncPathImplementation;

export type PollingSyncNotifier = PollingSyncNotifierImplementation;

export type {
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
  SyncNotifier,
  SyncRuntimeOptions,
  SyncSubscription,
} from "./adapter.ts";
export type { FurinSyncOption, FurinSyncOptions } from "./config.ts";
export type { SyncInput, SyncRouteOption } from "./plugin.ts";
export type { SyncChangePage } from "./stream.ts";
