import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { SyncAdapter } from "../../../src/server/sync/adapter";
import { resolveSyncPath, syncRuntimeOptions } from "../../../src/server/sync/config";
import { PollingSyncNotifier } from "../../../src/server/sync/notifier";
import { resolveSyncRuntime } from "../../../src/server/sync/runtime";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";

const principal = () => "principal";

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
  test("resolves a custom durable path from an explicit runtime", () => {
    const adapter = durableAdapter("host-local", async () => "0");
    const sync = { adapter, path: "/sync", principal };
    expect(resolveSyncPath(sync)).toBe("/sync");
    expect(syncRuntimeOptions(sync)).toEqual({ adapter, notifier: undefined, principal });
  });

  test("rejects process-local SQLite storage in production", () => {
    const database = new Database(":memory:");
    try {
      migrateSqliteSync(database);
      const adapter = sqliteSyncAdapter({ database, namespace: "runtime" });
      expect(() => resolveSyncRuntime({ adapter, principal }, false)).toThrow(
        "process-local SyncAdapter"
      );
    } finally {
      database.close();
    }
  });

  test("accepts an explicit host-local adapter in production", () => {
    const adapter = durableAdapter("host-local", async () => "0");
    expect(resolveSyncRuntime({ adapter, principal }, false).adapter).toBe(adapter);
  });

  test("requires distributed production adapters to choose their notifier explicitly", () => {
    const adapter = durableAdapter("distributed", async () => "0");

    expect(() => resolveSyncRuntime({ adapter, principal }, false)).toThrow(
      "Distributed production sync requires an explicit SyncNotifier"
    );

    const notifier = new PollingSyncNotifier(adapter, 250);
    expect(
      resolveSyncRuntime(
        {
          adapter,
          notifier,
          principal,
        },
        false
      ).notifier
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

    expect(() => resolveSyncRuntime({ adapter, notifier, principal }, true)).toThrow(
      "notification channels do not match"
    );
  });

  test("keeps polling as a development convenience", () => {
    const runtime = resolveSyncRuntime(
      {
        adapter: durableAdapter("distributed", async () => "0"),
        principal,
      },
      true
    );
    expect(runtime.notifier).toBeInstanceOf(PollingSyncNotifier);
  });
});
