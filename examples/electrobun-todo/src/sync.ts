import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { db, sqlite } from "./db";

migrateSqliteSync(sqlite);

// A local app has a single user.
export const sync = {
  adapter: drizzleSyncAdapter({ db, namespace: "relay" }),
  principal: () => "relay",
};
