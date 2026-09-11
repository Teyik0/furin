import { Elysia } from "elysia";
import { IS_DEV } from "../runtime-env.ts";
import type { SyncAdapter, SyncChange, SyncSubscription } from "./adapter.ts";
import type { FurinSyncOptions } from "./config.ts";
import { syncRuntimeOptions } from "./config.ts";
import { type ResolvedSyncRuntime, resolveSyncRuntime } from "./runtime.ts";

export type { ChangePage as SyncChangePage, SyncChange } from "./adapter.ts";

const DEFAULT_CHANGE_LIMIT = 100;
const MAX_CHANGE_LIMIT = 500;
const MAX_CURSOR_LENGTH = 128;
const SAFETY_POLL_INTERVAL_MS = IS_DEV ? 250 : 15_000;
const UNSIGNED_INTEGER_PATTERN = /^\d+$/;
const defaultSyncPath = "/_furin/sync";
const noOpSubscription: SyncSubscription = {
  unsubscribe: () => Promise.resolve(),
};

interface SyncCursorState {
  cursor: string;
  listeners: Set<(cursor: string) => void>;
  safetyPoll: ReturnType<typeof setInterval> | undefined;
  subscription: SyncSubscription;
}

const cursorStates = new Map<SyncAdapter, Promise<SyncCursorState>>();
const resolvedStates = new Set<SyncCursorState>();

function notifyState(state: SyncCursorState, cursor: string): void {
  if (state.cursor === cursor) {
    return;
  }
  state.cursor = cursor;
  for (const listener of state.listeners) {
    try {
      listener(cursor);
    } catch {
      // One disconnected browser must not prevent delivery to other tabs.
    }
  }
}

async function createCursorState(runtime: ResolvedSyncRuntime): Promise<SyncCursorState> {
  const state = {} as SyncCursorState;
  state.cursor = await runtime.adapter.currentCursor();
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
    state.safetyPoll = setInterval(() => {
      runtime.adapter
        .currentCursor()
        .then((cursor) => notifyState(state, cursor))
        .catch(() => undefined);
    }, SAFETY_POLL_INTERVAL_MS);
    state.safetyPoll.unref?.();
  }
  resolvedStates.add(state);
  return state;
}

export async function subscribeSyncCursor(
  options: FurinSyncOptions,
  listener: (cursor: string) => void
): Promise<{ unsubscribe: () => void }> {
  const runtime = resolveSyncRuntime(syncRuntimeOptions(options));
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
      if (state.safetyPoll) {
        clearInterval(state.safetyPoll);
      }
      state.subscription.unsubscribe().catch(() => undefined);
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

function clientInvalidations(change: SyncChange): string[] {
  const entries = new Set<string>();
  for (const invalidation of change.invalidations) {
    if (invalidation.kind === "tags") {
      entries.add("/:layout");
    } else {
      entries.add(
        invalidation.type === "layout" ? `${invalidation.path}:layout` : invalidation.path
      );
    }
  }
  return [...entries];
}

export function createSyncChangesPlugin(options: FurinSyncOptions) {
  const syncPath = options.path ?? defaultSyncPath;
  const runtime = resolveSyncRuntime(syncRuntimeOptions(options));
  return new Elysia({ name: `furin-sync-changes-${syncPath}` }).get(
    `${syncPath}/changes`,
    async ({ request, set }) => {
      set.headers["cache-control"] = "no-store";
      const query = parseChangeQuery(request);
      if ("error" in query) {
        return query.error;
      }
      const page = await runtime.adapter.readChanges(query);
      return {
        ...page,
        changes: page.changes.map((change) => ({
          cursor: change.cursor,
          invalidations: clientInvalidations(change),
        })),
      };
    }
  );
}

/** @internal — closes process-local stream state between tests. */
export function __resetSyncState(): void {
  for (const state of resolvedStates) {
    state.subscription.unsubscribe().catch(() => undefined);
    if (state.safetyPoll) {
      clearInterval(state.safetyPoll);
    }
    state.listeners.clear();
  }
  cursorStates.clear();
  resolvedStates.clear();
}
