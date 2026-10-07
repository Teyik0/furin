import { Database } from "bun:sqlite";
import { migrateSqliteSync } from "../../../../src/server/sync/sqlite/index.ts";

export type MigrationOutcome = { type: "ready" } | { error?: string; type: "completed" };

self.onmessage = (event: MessageEvent<{ barrier: SharedArrayBuffer; file: string }>) => {
  const database = new Database(event.data.file);
  database.run("PRAGMA busy_timeout=10000");
  const barrier = new Int32Array(event.data.barrier);
  self.postMessage({ type: "ready" } satisfies MigrationOutcome);
  Atomics.wait(barrier, 0, 0);
  let outcome: MigrationOutcome = { type: "completed" };
  try {
    migrateSqliteSync(database);
  } catch (error) {
    outcome = { error: String(error), type: "completed" };
  } finally {
    database.close();
    self.postMessage(outcome);
    self.close();
  }
};
