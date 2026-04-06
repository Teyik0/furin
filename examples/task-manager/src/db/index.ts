import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
// biome-ignore lint/performance/noNamespaceImport: ok
import * as schema from "./schema";

const sqlite = new Database("task-manager.db", { create: true });
sqlite.run("PRAGMA journal_mode = WAL");
sqlite.run("PRAGMA foreign_keys = ON");

export const db = drizzle(sqlite, { schema });
