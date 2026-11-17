import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import init from "../../drizzle/20261113074848_init/migration.sql" with { type: "text" };

// The desktop host sets FURIN_APP_DATA_DIR before importing the server.
const filename =
  process.env.FURIN_TODO_DATABASE ??
  join(process.env.FURIN_APP_DATA_DIR ?? ".furin", "todos.sqlite");
const directory = dirname(filename);
if (directory !== ".") {
  mkdirSync(directory, { recursive: true });
}

export const sqlite = new Database(filename, { create: true });
export const db = drizzle({ client: sqlite });

// Imported as text so bundles and compiled binaries carry their migrations.
migrate(db, [{ name: "20261113074848_init", timestamp: 1_794_556_128_000, sql: init }]);

export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
