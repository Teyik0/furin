import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureTaskManagerSchema } from "./bootstrap";
import { relations } from "./schema";

export const sqlite = new Database(process.env.TASK_MANAGER_DB_PATH ?? "task-manager.db", {
  create: true,
});
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA busy_timeout = 5000");
sqlite.run("PRAGMA foreign_keys = ON");
ensureTaskManagerSchema(sqlite);

export const db = drizzle({ client: sqlite, relations });

export type TaskManagerTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
