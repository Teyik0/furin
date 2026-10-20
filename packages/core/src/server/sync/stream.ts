import { Elysia } from "elysia";
import { IS_DEV } from "../runtime-env.ts";
import type { SyncAdapter, SyncSubscription } from "./adapter.ts";
import type { FurinSyncOptions } from "./config.ts";
import { syncRuntimeOptions } from "./config.ts";
import { readPrincipalChanges } from "./principal-journal.ts";
import { markInternalRead } from "./queries.ts";
import { type ResolvedSyncRuntime, resolveSyncRuntime } from "./runtime.ts";

export type { ChangePage as SyncChangePage, SyncChange } from "./adapter.ts";

/** Bursts of commits wake browsers once per window, always with the latest cursor. */
const BROADCAST_WINDOW_MS = 100;
const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 500;
const MAX_CURSOR_LENGTH = 128;
const DEVELOPMENT_SAFETY_POLL_INTERVAL_MS = 250;
const PRODUCTION_SAFETY_POLL_INTERVAL_MS = 15_000;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const defaultSyncPath = "/_furin/sync";
const noOpSubscription: SyncSubscription = {
  unsubscribe: () => Promise.resolve(),
};

interface SyncCursorState {
  broadcast: ReturnType<typeof setTimeout> | undefined;
  cursor: string;
  latest: string;
  listeners: Set<(cursor: string) => void>;
  safetyPoll: ReturnType<typeof setInterval> | undefined;
  subscription: SyncSubscription;
}

const cursorStates = new Map<SyncAdapter, Promise<SyncCursorState>>();
const resolvedStates = new Set<SyncCursorState>();
const pendingUnsubscriptions = new Set<Promise<void>>();
const unsubscriptions = new WeakMap<SyncSubscription, Promise<void>>();

function trackUnsubscription(subscription: SyncSubscription): Promise<void> {
  const existing = unsubscriptions.get(subscription);
  if (existing) {
    return existing;
  }
  const pending = subscription.unsubscribe();
  unsubscriptions.set(subscription, pending);
  pendingUnsubscriptions.add(pending);
  pending.finally(() => pendingUnsubscriptions.delete(pending)).catch(() => undefined);
  return pending;
}

function broadcastState(state: SyncCursorState): void {
  state.broadcast = undefined;
  if (state.cursor === state.latest) {
    return;
  }
  state.cursor = state.latest;
  for (const listener of state.listeners) {
    try {
      listener(state.cursor);
    } catch {
      // One disconnected browser must not prevent delivery to other tabs.
    }
  }
}

function notifyState(state: SyncCursorState, cursor: string): void {
  state.latest = cursor;
  if (state.broadcast || state.cursor === cursor) {
    return;
  }
  state.broadcast = setTimeout(() => broadcastState(state), BROADCAST_WINDOW_MS);
  state.broadcast.unref?.();
}

function stopState(state: SyncCursorState): void {
  clearInterval(state.safetyPoll);
  clearTimeout(state.broadcast);
}

async function createCursorState(runtime: ResolvedSyncRuntime): Promise<SyncCursorState> {
  const state = {} as SyncCursorState;
  state.cursor = await runtime.adapter.currentCursor();
  state.latest = state.cursor;
  state.broadcast = undefined;
  state.listeners = new Set();
  state.safetyPoll = undefined;
  let subscriptionFailed = false;
  state.subscription = await runtime.notifier
    .subscribe((cursor) => notifyState(state, cursor))
    .catch(() => {
      subscriptionFailed = true;
      return noOpSubscription;
    });
  if (runtime.notifier.recovery !== "self" || subscriptionFailed) {
    const interval = runtime.development
      ? DEVELOPMENT_SAFETY_POLL_INTERVAL_MS
      : PRODUCTION_SAFETY_POLL_INTERVAL_MS;
    state.safetyPoll = setInterval(() => {
      runtime.adapter
        .currentCursor()
        .then((cursor) => notifyState(state, cursor))
        .catch(() => undefined);
    }, interval);
    state.safetyPoll.unref?.();
  }
  resolvedStates.add(state);
  return state;
}

export async function subscribeSyncCursor(
  options: FurinSyncOptions,
  development: boolean,
  listener: (cursor: string) => void
): Promise<{ unsubscribe: () => void }> {
  const runtime = resolveSyncRuntime(syncRuntimeOptions(options), development);
  const statePromise = getCursorState(runtime);
  const state = await statePromise;
  state.listeners.add(listener);
  listener(state.cursor);
  let subscribed = true;
  return {
    unsubscribe: () => {
      if (!subscribed) {
        return;
      }
      subscribed = false;
      state.listeners.delete(listener);
      if (state.listeners.size > 0) {
        return;
      }
      if (cursorStates.get(runtime.adapter) === statePromise) {
        cursorStates.delete(runtime.adapter);
      }
      resolvedStates.delete(state);
      stopState(state);
      trackUnsubscription(state.subscription);
    },
  };
}

function getCursorState(runtime: ResolvedSyncRuntime): Promise<SyncCursorState> {
  const existing = cursorStates.get(runtime.adapter);
  if (existing) {
    return existing;
  }
  const state = createCursorState(runtime);
  cursorStates.set(runtime.adapter, state);
  state.catch(() => {
    if (cursorStates.get(runtime.adapter) === state) {
      cursorStates.delete(runtime.adapter);
    }
  });
  return state;
}

function parseChangeQuery(
  request: Request
): { after: string | undefined; limit: number } | { error: Response } {
  const url = new URL(request.url);
  const after = url.searchParams.get("after") ?? undefined;
  if (after !== undefined && (after.length === 0 || after.length > MAX_CURSOR_LENGTH)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_CURSOR" }, { status: 400 }) };
  }
  const limitValue = url.searchParams.get("limit");
  if (limitValue !== null && !UNSIGNED_INTEGER_PATTERN.test(limitValue)) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  const limit = limitValue === null ? DEFAULT_CHANGE_LIMIT : Number.parseInt(limitValue, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CHANGE_LIMIT) {
    return { error: Response.json({ code: "FURIN_INVALID_SYNC_LIMIT" }, { status: 400 }) };
  }
  return { after, limit };
}

/** A standalone changes endpoint belongs to no Furin runtime: it follows the default mode. */
export function createSyncChangesPlugin(options: FurinSyncOptions) {
  return createRuntimeSyncChangesPlugin(options, IS_DEV);
}

/** The changes endpoint of a Furin runtime, validated for that runtime's mode. */
export function createRuntimeSyncChangesPlugin(options: FurinSyncOptions, development: boolean) {
  const syncPath = options.path ?? defaultSyncPath;
  const runtime = resolveSyncRuntime(syncRuntimeOptions(options), development);
  return new Elysia({ name: `furin-sync-changes-${syncPath}` }).get(
    `${syncPath}/changes`,
    async (context) => {
      const { request, set } = context;
      markInternalRead(request);
      set.headers["cache-control"] = "no-store";
      const query = parseChangeQuery(request);
      if ("error" in query) {
        return query.error;
      }
      const principal = await options.principal(context);
      if (principal.length === 0) {
        return new Response("Unauthorized", { status: 401 });
      }
      return readPrincipalChanges(runtime.adapter, query, principal);
    }
  );
}

/** @internal — closes process-local stream state between tests. */
export function __resetSyncState(): void {
  for (const state of resolvedStates) {
    trackUnsubscription(state.subscription);
    stopState(state);
    state.listeners.clear();
  }
  cursorStates.clear();
  resolvedStates.clear();
}

/** Release process-local Sync subscriptions after Bun has drained HTTP traffic. */
export async function closeSyncCursorStates(): Promise<void> {
  const pending = [...cursorStates.values()];
  cursorStates.clear();
  const states = await Promise.allSettled(pending);
  await Promise.allSettled(
    states.flatMap((result) => {
      if (result.status !== "fulfilled") {
        return [];
      }
      const state = result.value;
      stopState(state);
      state.listeners.clear();
      resolvedStates.delete(state);
      return [trackUnsubscription(state.subscription)];
    })
  );
  await waitForSyncCursorUnsubscriptions();
}

/** Wait for released connections without closing subscriptions owned by other servers. */
export async function waitForSyncCursorUnsubscriptions(): Promise<void> {
  await Promise.allSettled([...pendingUnsubscriptions]);
}
