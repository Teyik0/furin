import { asc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { cards } from "@/db/schema";

export type { Card, ColumnType } from "@/db/schema";

import type { Card, ColumnType } from "@/db/schema";

// ---------------------------------------------------------------------------
// Cards queries
// ---------------------------------------------------------------------------

export function getCard(id: string): Card | undefined {
  return db.select().from(cards).where(eq(cards.id, id)).get() ?? undefined;
}

export function getCardsForBoard(boardId: string): Card[] {
  return db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all();
}

export function createCard(boardId: string, title: string, column: ColumnType): Card {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  db.insert(cards)
    .values({
      id,
      boardId,
      column,
      title,
      description: "",
      position: sql<number>`coalesce(
        (
          select max(${cards.position})
          from ${cards}
          where ${cards.boardId} = ${boardId} and ${cards.column} = ${column}
        ),
        -1
      ) + 1`,
      createdAt,
    })
    .run();

  const card = db.select().from(cards).where(eq(cards.id, id)).get();
  if (!card) {
    throw new Error(`Failed to create card "${id}"`);
  }

  return card;
}

export function updateCard(
  id: string,
  data: Partial<Pick<Card, "title" | "description" | "column" | "position">>
): Card | undefined {
  const existing = db.select().from(cards).where(eq(cards.id, id)).get();
  if (!existing) {
    return;
  }

  const nextValues: Partial<Pick<Card, "title" | "description" | "column" | "position">> = {};
  if (data.title !== undefined) {
    nextValues.title = data.title;
  }
  if (data.description !== undefined) {
    nextValues.description = data.description;
  }
  if (data.column !== undefined) {
    nextValues.column = data.column;
  }
  if (data.position !== undefined) {
    nextValues.position = data.position;
  }

  if (Object.keys(nextValues).length === 0) {
    return existing;
  }

  db.update(cards).set(nextValues).where(eq(cards.id, id)).run();
  return db.select().from(cards).where(eq(cards.id, id)).get() ?? undefined;
}

export function deleteCard(id: string): boolean {
  const result = db.delete(cards).where(eq(cards.id, id)).returning({ id: cards.id }).all();
  return result.length > 0;
}
