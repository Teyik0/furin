import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";

// The desktop host sets FURIN_APP_DATA_DIR before importing the server.
const filename =
  process.env.FURIN_TODO_DATABASE ??
  join(process.env.FURIN_APP_DATA_DIR ?? ".furin", "todos.sqlite");
mkdirSync(dirname(filename), { recursive: true });

export const sqlite = new Database(filename, { create: true });
sqlite.run(`CREATE TABLE IF NOT EXISTS todo (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  completed INTEGER NOT NULL,
  created_at TEXT NOT NULL
)`);

export const db = drizzle(sqlite);

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
