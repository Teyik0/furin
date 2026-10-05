import { Database } from "bun:sqlite";
import { furinSync } from "@teyik0/furin";
import type { SyncInvalidationInput } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import type { Todo } from "./todo-types";

declare module "@teyik0/furin/routes" {
  interface SyncQueryMap {
    nativeTodos: object;
  }
}

const todos = sqliteTable("todo", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  completed: integer("completed", { mode: "boolean" }).notNull(),
  createdAt: text("created_at").notNull(),
});

function validTitle(title: string) {
  return title.trim().length > 0 && title.trim().length <= 200;
}

const invalidations = [
  { id: "nativeTodos", scope: {} },
  { path: "/", type: "page" },
] satisfies SyncInvalidationInput;

export function createTodoBackend(filename: string) {
  const sqlite = new Database(filename);
  sqlite.run(`
    CREATE TABLE IF NOT EXISTS todo (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      completed INTEGER NOT NULL, created_at TEXT NOT NULL
    )
  `);
  migrateSqliteSync(sqlite);
  const db = drizzle(sqlite);
  const sync = {
    adapter: drizzleSyncAdapter({ db, namespace: "native-todos" }),
    principal: () => "native-todos",
  };
  const list = (): Todo[] => db.select().from(todos).orderBy(todos.createdAt, todos.id).all();
  const api = new Elysia({ prefix: "/api" })
    .use(furinSync(sync))
    .get("/todos", { sync: { id: "nativeTodos" } }, list)
    .post(
      "/todos",
      { body: t.Object({ title: t.String() }), sync: { invalidate: invalidations } },
      ({ body, mutation, problem }) => {
        if (!validTitle(body.title)) {
          return problem(422, { detail: "Title must contain 1–200 characters" });
        }
        return mutation((tx) =>
          tx
            .insert(todos)
            .values({
              id: crypto.randomUUID(),
              title: body.title.trim(),
              completed: false,
              createdAt: new Date().toISOString(),
            })
            .returning()
            .get()
        );
      }
    )
    .patch(
      "/todos/:id",
      {
        body: t.Object({ title: t.Optional(t.String()), completed: t.Optional(t.Boolean()) }),
        sync: { invalidate: invalidations },
      },
      ({ body, params, mutation, problem }) => {
        if (
          (body.title === undefined && body.completed === undefined) ||
          (body.title !== undefined && !validTitle(body.title))
        ) {
          return problem(422, { detail: "Provide a valid title or completed flag" });
        }
        return mutation((tx) => {
          const todo = tx
            .update(todos)
            .set({
              title: body.title?.trim(),
              completed: body.completed,
            })
            .where(eq(todos.id, params.id))
            .returning()
            .get();
          return todo ?? problem(404, { detail: "Todo not found" });
        });
      }
    )
    .delete(
      "/todos/:id",
      { sync: { invalidate: invalidations } },
      ({ params, mutation, problem }) =>
        mutation((tx) => {
          const todo = tx.delete(todos).where(eq(todos.id, params.id)).returning().get();
          return todo ? { ok: true as const } : problem(404, { detail: "Todo not found" });
        })
    );
  return { api, sync, list, close: () => sqlite.close() };
}

export type TodoApi = ReturnType<typeof createTodoBackend>["api"];
