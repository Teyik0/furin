import { afterEach, expect, jest, test } from "bun:test";
import type { SyncAdapter } from "../../../src/server/sync/adapter.ts";
import { __resetSyncState, subscribeSyncCursor } from "../../../src/server/sync/stream.ts";

afterEach(() => {
  __resetSyncState();
  jest.useRealTimers();
});

function syncWithManualNotifier() {
  const adapter: SyncAdapter = {
    abortMutation: async () => undefined,
    beginMutation: async () => ({ kind: "conflict", reason: "in-progress" }),
    completeMutation: async () => ({ kind: "lost" }),
    currentCursor: async () => "0",
    readChanges: async () => ({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: async () => "lost",
    scope: "distributed",
  };
  const listeners: Array<(cursor: string) => void> = [];
  return {
    publish: (cursor: string) => {
      for (const listener of listeners) {
        listener(cursor);
      }
    },
    sync: {
      adapter,
      notifier: {
        publish: () => Promise.resolve(),
        recovery: "self" as const,
        subscribe: (listener: (cursor: string) => void) => {
          listeners.push(listener);
          return Promise.resolve({ unsubscribe: () => Promise.resolve() });
        },
      },
      principal: () => "alice",
    },
  };
}

test("coalesces cursor bursts into one trailing broadcast of the latest cursor", async () => {
  jest.useFakeTimers();
  const { publish, sync } = syncWithManualNotifier();
  const received: string[] = [];
  await subscribeSyncCursor(sync, (cursor) => received.push(cursor));
  expect(received).toEqual(["0"]);

  publish("1");
  publish("2");
  publish("3");
  expect(received).toEqual(["0"]);
  jest.advanceTimersByTime(100);
  expect(received).toEqual(["0", "3"]);

  publish("4");
  jest.advanceTimersByTime(100);
  expect(received).toEqual(["0", "3", "4"]);
});
