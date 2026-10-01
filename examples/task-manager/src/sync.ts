import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { db, sqlite } from "./db";

declare module "@teyik0/furin/routes" {
  interface SyncQueryMap {
    board: { boardId: string | undefined };
    boards: object;
    card: { id: string | undefined };
  }
}

migrateSqliteSync(sqlite);

const TASK_MANAGER_SYNC_ID = "task-manager";

export const taskManagerSync = {
  adapter: drizzleSyncAdapter({ db, namespace: TASK_MANAGER_SYNC_ID }),
  principal: () => TASK_MANAGER_SYNC_ID,
};
