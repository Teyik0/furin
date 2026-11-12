import { defineRelations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const boards = sqliteTable("boards", {
  createdAt: text("created_at").notNull(),
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

export type ColumnType = "backlog" | "todo" | "doing" | "done";

export const cards = sqliteTable("cards", {
  boardId: text("board_id")
    .notNull()
    .references(() => boards.id, { onDelete: "cascade" }),
  column: text("column", { enum: ["backlog", "todo", "doing", "done"] })
    .notNull()
    .$type<ColumnType>(),
  createdAt: text("created_at").notNull(),
  description: text("description").notNull().default(""),
  id: text("id").primaryKey(),
  position: integer("position").notNull().default(0),
  title: text("title").notNull(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const relations = defineRelations({ boards, cards }, (r) => ({
  boards: { cards: r.many.cards() },
  cards: { board: r.one.boards({ from: r.cards.boardId, to: r.boards.id }) },
}));

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Board = typeof boards.$inferSelect;
export type Card = typeof cards.$inferSelect;

export interface BoardData {
  board: Board;
  cards: Card[];
}
