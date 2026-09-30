export interface StoredResponse {
  body: Uint8Array;
  headers: ReadonlyArray<readonly [string, string]>;
  status: number;
}

export interface BeginMutationInput {
  fingerprint: string;
  key: string;
  principal: string;
}

export interface MutationLease {
  id: string;
  key: string;
  leaseMs: number;
  principal: string;
}

export type BeginMutationResult =
  | { kind: "execute"; lease: MutationLease }
  | { kind: "replay"; response: StoredResponse }
  | { kind: "conflict"; reason: "in-progress" | "payload-mismatch" };

export type SyncInvalidation =
  | { kind: "path"; path: string; type: "layout" | "page" }
  | { kind: "tags"; tags: readonly string[] };

export interface CompleteMutationInput {
  invalidations: readonly SyncInvalidation[];
  lease: MutationLease;
  response: StoredResponse;
}

export type CompleteMutationResult =
  | { cursor: string | undefined; kind: "committed" }
  | { kind: "lost" };

export interface SyncChange {
  cursor: string;
  invalidations: readonly SyncInvalidation[];
}

export interface ReadChangesInput {
  after: string | undefined;
  limit: number;
}

export interface ChangePage {
  changes: readonly SyncChange[];
  cursor: string;
  hasMore: boolean;
  reset: boolean;
}

export interface SyncAdapter {
  abortMutation: (lease: MutationLease) => Promise<void>;
  beginMutation: (input: BeginMutationInput) => Promise<BeginMutationResult>;
  completeMutation: (input: CompleteMutationInput) => Promise<CompleteMutationResult>;
  currentCursor: () => Promise<string>;
  /**
   * Identifies the journal namespace's notification channel.
   */
  readonly notificationChannel?: string;
  /** False when completion requires an explicit wake-up after cache invalidation. */
  readonly publishesNotifications?: boolean;
  readChanges: (input: ReadChangesInput) => Promise<ChangePage>;
  renewMutation: (lease: MutationLease) => Promise<"lost" | "renewed">;
  readonly scope: "distributed" | "host-local" | "process-local";
}

export interface SyncSubscription {
  unsubscribe: () => Promise<void>;
}

export interface SyncNotifier {
  /**
   * Matches the adapter's journal namespace for notifications and recovery.
   */
  readonly notificationChannel?: string;
  publish: (cursor: string) => Promise<void>;
  /**
   * Declares that the notifier independently recovers missed wake-ups, so the
   * SSE coordinator does not need its compatibility safety poll.
   */
  readonly recovery?: "self";
  subscribe: (listener: (cursor: string) => void) => Promise<SyncSubscription>;
}

export interface AtomicMutationValue<T> {
  invalidations: readonly SyncInvalidation[];
  response: StoredResponse;
  value: T;
}

export interface AtomicMutationResult<T> {
  cursor: string | undefined;
  kind: "committed";
  response: StoredResponse;
  value: T;
}

export interface TransactionalSyncAdapter<Tx, Mode extends "async" | "sync"> extends SyncAdapter {
  executeMutation: <T>(
    lease: MutationLease,
    callback: (tx: Tx) => AtomicMutationValue<T> | Promise<AtomicMutationValue<T>>
  ) => Promise<AtomicMutationResult<T>>;
  readonly transactionMode: Mode;
}

export type SyncTransaction<Adapter> =
  Adapter extends TransactionalSyncAdapter<infer Tx, "async" | "sync"> ? Tx : never;

export type SyncMutation<Adapter> = <T>(
  callback: (
    tx: SyncTransaction<Adapter>
  ) => T &
    (Adapter extends { transactionMode: "sync" }
      ? T extends PromiseLike<unknown>
        ? never
        : unknown
      : unknown)
) => Promise<Awaited<T>>;

export interface SyncRuntimeOptions<Adapter extends SyncAdapter = SyncAdapter> {
  adapter: Adapter;
  notifier?: SyncNotifier;
  principal: (context: Context) => Promise<string> | string;
}

import type { Context } from "elysia";
