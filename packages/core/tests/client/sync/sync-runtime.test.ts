import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env";
import type { SyncAdapter } from "../../../src/server/sync/adapter";
import { resolveSyncStreamPath, syncRuntimeOptions } from "../../../src/server/sync/config";
import { PollingSyncNotifier } from "../../../src/server/sync/notifier";
import { resolveSyncRuntime } from "../../../src/server/sync/runtime";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";

const originalDevMode = IS_DEV;
const principal = () => "principal";

afterEach(() => {
  __setDevMode(originalDevMode);
});

function durableAdapter(
  scope: "distributed" | "host-local",
  currentCursor: () => Promise<string>
): SyncAdapter {
  return {
    abortMutation: async () => undefined,
    beginMutation: async () => ({ kind: "conflict", reason: "in-progress" }),
    completeMutation: async () => ({ kind: "lost" }),
    currentCursor,
    readChanges: async () => ({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: async () => "lost",
    scope,
  };
}

describe("sync runtime", () => {
  test("resolves a custom stream path from an explicit runtime", () => {
    const adapter = durableAdapter("host-local", async () => "0");
    const sync = { adapter, principal, streamPath: "/events" };
    expect(resolveSyncStreamPath(sync)).toBe("/events");
    expect(syncRuntimeOptions(sync)).toEqual({ adapter, notifier: undefined, principal });
  });

  test("rejects process-local SQLite storage in production", () => {
    __setDevMode(false);
    const database = new Database(":memory:");
    try {
      migrateSqliteSync(database);
      const adapter = sqliteSyncAdapter({ database, namespace: "runtime" });
      expect(() => resolveSyncRuntime({ adapter, principal })).toThrow("process-local SyncAdapter");
    } finally {
      database.close();
    }
  });

  test("accepts an explicit host-local adapter in production", () => {
    __setDevMode(false);
    const adapter = durableAdapter("host-local", async () => "0");
    expect(resolveSyncRuntime({ adapter, principal }).adapter).toBe(adapter);
  });

  test("requires distributed production adapters to choose their notifier explicitly", () => {
    __setDevMode(false);
    const adapter = durableAdapter("distributed", async () => "0");

    expect(() => resolveSyncRuntime({ adapter, principal })).toThrow(
      "Distributed production sync requires an explicit SyncNotifier"
    );

    const notifier = new PollingSyncNotifier(adapter, 250);
    expect(
      resolveSyncRuntime({
        adapter,
        notifier,
        principal,
      }).notifier
    ).toBe(notifier);
  });

  test("rejects mismatched transactional notification channels", () => {
    const adapter = {
      ...durableAdapter("distributed", async () => "0"),
      notificationChannel: "furin-sync-a",
    };
    const notifier = {
      notificationChannel: "furin-sync-b",
      publish: () => Promise.resolve(),
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    };

    expect(() => resolveSyncRuntime({ adapter, notifier, principal })).toThrow(
      "notification channels do not match"
    );
  });

  test("keeps polling as a development convenience", () => {
    __setDevMode(true);
    const runtime = resolveSyncRuntime({
      adapter: durableAdapter("distributed", async () => "0"),
      principal,
    });
    expect(runtime.notifier).toBeInstanceOf(PollingSyncNotifier);
  });
});
