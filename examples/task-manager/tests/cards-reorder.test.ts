import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { and, asc, eq, sql } from "drizzle-orm";
import { updateCard } from "../src/api/modules/cards/service";
import { db } from "../src/db";
import { boards, cards } from "../src/db/schema";

const BOARD_ID = "test-board-reorder";

function insertCard(id: string, column: "backlog" | "todo" | "doing" | "done", position: number) {
  db.insert(cards)
    .values({
      boardId: BOARD_ID,
      column,
      createdAt: "2026-06-10T00:00:00.000Z",
      description: "",
      id,
      position,
      title: id,
    })
    .run();
}

function listColumn(column: "backlog" | "todo" | "doing" | "done") {
  return db
    .select({
      id: cards.id,
      position: cards.position,
    })
    .from(cards)
    .where(and(eq(cards.boardId, BOARD_ID), eq(cards.column, column)))
    .orderBy(asc(cards.position))
    .all();
}

function totalChanges() {
  const result = db.get(sql<[number]>`select total_changes()`);
  const total = result?.[0];
  if (total === undefined) {
    throw new Error("Failed to read SQLite total_changes()");
  }
  return total;
}

describe("cards reorder service", () => {
  beforeEach(() => {
    db.delete(cards).where(eq(cards.boardId, BOARD_ID)).run();
    db.delete(boards).where(eq(boards.id, BOARD_ID)).run();
    db.insert(boards)
      .values({
        createdAt: "2026-06-10T00:00:00.000Z",
        id: BOARD_ID,
        name: "Reorder test",
      })
      .run();

    insertCard("test-card-todo-0", "todo", 0);
    insertCard("test-card-todo-1", "todo", 1);
    insertCard("test-card-doing-0", "doing", 0);
    insertCard("test-card-doing-1", "doing", 1);
  });

  afterEach(() => {
    db.delete(cards).where(eq(cards.boardId, BOARD_ID)).run();
    db.delete(boards).where(eq(boards.id, BOARD_ID)).run();
  });

  test("moving one card reorders source and destination columns in one service call", () => {
    const moved = db.transaction((tx) =>
      updateCard(tx, "test-card-todo-0", { column: "doing", position: 1 })
    );

    expect(moved?.column).toBe("doing");
    expect(moved?.position).toBe(1);
    expect(listColumn("todo")).toEqual([{ id: "test-card-todo-1", position: 0 }]);
    expect(listColumn("doing")).toEqual([
      { id: "test-card-doing-0", position: 0 },
      { id: "test-card-todo-0", position: 1 },
      { id: "test-card-doing-1", position: 2 },
    ]);
  });

  test("ignores drag updates that keep the card in the same column and position", () => {
    const beforeChanges = totalChanges();
    const moved = db.transaction((tx) =>
      updateCard(tx, "test-card-todo-1", { column: "todo", position: 1 })
    );

    expect(moved?.column).toBe("todo");
    expect(moved?.position).toBe(1);
    expect(listColumn("todo")).toEqual([
      { id: "test-card-todo-0", position: 0 },
      { id: "test-card-todo-1", position: 1 },
    ]);
    expect(totalChanges()).toBe(beforeChanges);
  });
});
