import { and, asc, eq, sql } from "drizzle-orm";
import { db, type TaskManagerTransaction } from "@/db";
import { cards } from "@/db/schema";

export type { Card, ColumnType } from "@/db/schema";

import type { Card, ColumnType } from "@/db/schema";

type UpdateCardData = Partial<Pick<Card, "title" | "description" | "column" | "position">>;

// ---------------------------------------------------------------------------
// Cards queries
// ---------------------------------------------------------------------------

export function getCard(id: string, transaction?: TaskManagerTransaction): Card | undefined {
  return (transaction ?? db).select().from(cards).where(eq(cards.id, id)).get() ?? undefined;
}

export function createCard(
  tx: TaskManagerTransaction,
  boardId: string,
  title: string,
  column: ColumnType
): Card {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();

  tx.insert(cards)
    .values({
      boardId,
      column,
      createdAt,
      description: "",
      id,
      position: sql<number>`coalesce(
        (
          select max(${cards.position})
          from ${cards}
          where ${cards.boardId} = ${boardId} and ${cards.column} = ${column}
        ),
        -1
      ) + 1`,
      title,
    })
    .run();

  const card = tx.select().from(cards).where(eq(cards.id, id)).get();
  if (!card) {
    throw new Error(`Failed to create card "${id}"`);
  }

  return card;
}

export function updateCard(
  tx: TaskManagerTransaction,
  id: string,
  data: UpdateCardData
): Card | undefined {
  const existing = tx.select().from(cards).where(eq(cards.id, id)).get();
  if (!existing) {
    return;
  }

  const nextValues: UpdateCardData = {};
  if (data.title !== undefined) {
    nextValues.title = data.title;
  }
  if (data.description !== undefined) {
    nextValues.description = data.description;
  }

  if (data.column !== undefined || data.position !== undefined) {
    if (keepsCardPosition(existing, data)) {
      if (Object.keys(nextValues).length === 0) {
        return existing;
      }
      tx.update(cards).set(nextValues).where(eq(cards.id, id)).run();
      return tx.select().from(cards).where(eq(cards.id, id)).get() ?? undefined;
    }
    return reorderCard(tx, existing, data, nextValues);
  }

  if (Object.keys(nextValues).length === 0) {
    return existing;
  }

  tx.update(cards).set(nextValues).where(eq(cards.id, id)).run();
  return tx.select().from(cards).where(eq(cards.id, id)).get() ?? undefined;
}

function clampPosition(position: number, maxPosition: number): number {
  if (!Number.isFinite(position)) {
    return maxPosition;
  }
  return Math.max(0, Math.min(Math.trunc(position), maxPosition));
}

function keepsCardPosition(existing: Card, data: UpdateCardData): boolean {
  const targetColumn = data.column ?? existing.column;
  if (targetColumn !== existing.column) {
    return false;
  }
  if (data.position === undefined) {
    return true;
  }
  return Number.isFinite(data.position) && Math.trunc(data.position) === existing.position;
}

function reorderCard(
  tx: TaskManagerTransaction,
  existing: Card,
  data: UpdateCardData,
  nextValues: UpdateCardData
): Card {
  const targetColumn = data.column ?? existing.column;
  const targetSiblings = tx
    .select()
    .from(cards)
    .where(and(eq(cards.boardId, existing.boardId), eq(cards.column, targetColumn)))
    .orderBy(asc(cards.position))
    .all()
    .filter((card) => card.id !== existing.id);

  const fallbackPosition =
    targetColumn === existing.column
      ? targetSiblings.findIndex((card) => card.position > existing.position)
      : targetSiblings.length;
  const targetPosition = clampPosition(
    data.position ?? (fallbackPosition === -1 ? targetSiblings.length : fallbackPosition),
    targetSiblings.length
  );

  const movedCard: Card = {
    ...existing,
    ...nextValues,
    column: targetColumn,
    position: targetPosition,
  };
  const targetCards = [...targetSiblings];
  targetCards.splice(targetPosition, 0, movedCard);

  for (const [position, card] of targetCards.entries()) {
    tx.update(cards)
      .set({
        ...(card.id === existing.id ? nextValues : {}),
        column: targetColumn,
        position,
      })
      .where(eq(cards.id, card.id))
      .run();
  }

  if (existing.column !== targetColumn) {
    const sourceCards = tx
      .select()
      .from(cards)
      .where(and(eq(cards.boardId, existing.boardId), eq(cards.column, existing.column)))
      .orderBy(asc(cards.position))
      .all()
      .filter((card) => card.id !== existing.id);

    for (const [position, card] of sourceCards.entries()) {
      tx.update(cards).set({ position }).where(eq(cards.id, card.id)).run();
    }
  }

  const updated = tx.select().from(cards).where(eq(cards.id, existing.id)).get();
  if (!updated) {
    throw new Error(`Failed to reorder card "${existing.id}"`);
  }
  return updated;
}

export function deleteCard(tx: TaskManagerTransaction, id: string): boolean {
  const result = tx.delete(cards).where(eq(cards.id, id)).returning({ id: cards.id }).all();
  return result.length > 0;
}
