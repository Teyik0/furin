import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import init from "../../drizzle/20261113075539_init/migration.sql" with { type: "text" };
import { relations } from "./schema";

// `bun test` sets NODE_ENV: native and hot-reloaded module copies share one in-memory database per worker.
const filename =
  process.env.NODE_ENV === "test"
    ? "file:task-manager-test?mode=memory&cache=shared"
    : "task-manager.db";
export const sqlite = new Database(filename, { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA busy_timeout = 5000");
sqlite.run("PRAGMA foreign_keys = ON");

export const db = drizzle({ client: sqlite, relations });

// Imported as text so the compiled binary carries its migrations.
migrate(db, [{ name: "20261113075539_init", timestamp: 1_794_556_539_000, sql: init }]);

export type TaskManagerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
