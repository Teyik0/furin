import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureTaskManagerSchema } from "./bootstrap";
// biome-ignore lint/performance/noNamespaceImport: ok
import * as schema from "./schema";

export const sqlite = new Database(process.env.TASK_MANAGER_DB_PATH ?? "task-manager.db", {
  create: true,
});
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA busy_timeout = 5000");
sqlite.run("PRAGMA foreign_keys = ON");
ensureTaskManagerSchema(sqlite);

export const db = drizzle(sqlite, { schema });
