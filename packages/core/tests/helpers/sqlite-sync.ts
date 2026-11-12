import { Database } from "bun:sqlite";
import type { SyncNotifier } from "../../src/server/sync/adapter.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../src/server/sync/sqlite/index.ts";

/** In-memory SQLite Sync options for principal `alice`; close `database` when done. */
export function sqliteSync(namespace: string, notifier: SyncNotifier | undefined) {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  return {
    database,
    sync: {
      adapter: sqliteSyncAdapter({ database, namespace }),
      notifier,
      principal: () => "alice",
    },
  };
}
