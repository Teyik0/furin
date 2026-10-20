import { asc, eq } from "drizzle-orm";
import { db, type Transaction } from "../../../db";
import { type Todo, todos } from "../../../db/schema";
import type { ByIdPatch } from "./model";

export function listTodos(): Todo[] {
  return db.select().from(todos).orderBy(asc(todos.createdAt), asc(todos.id)).all();
}

export function createTodo(tx: Transaction, title: string): Todo {
  return tx
    .insert(todos)
    .values({
      id: crypto.randomUUID(),
      title: title.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .get();
}

export function updateTodo(
  tx: Transaction,
  id: string,
  changes: ByIdPatch["Body"]
): Todo | undefined {
  return tx
    .update(todos)
    .set({ title: changes.title?.trim(), completed: changes.completed })
    .where(eq(todos.id, id))
    .returning()
    .get();
}

export function deleteTodo(tx: Transaction, id: string): Todo | undefined {
  return tx.delete(todos).where(eq(todos.id, id)).returning().get();
}
