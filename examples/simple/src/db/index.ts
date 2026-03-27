import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { accounts, comments, sessions, users, verifications } from "./schema";

const sqlite = new Database("app.db");
sqlite.query("PRAGMA journal_mode = WAL;").run();

const schema = { accounts, comments, sessions, users, verifications };

export const db: BunSQLiteDatabase<typeof schema> = drizzle({
  client: sqlite,
  schema,
});
