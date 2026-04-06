import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export const boards = sqliteTable("boards", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
});

export type ColumnType = "backlog" | "todo" | "doing" | "done";

export const cards = sqliteTable("cards", {
  id: text("id").primaryKey(),
  boardId: text("board_id")
    .notNull()
    .references(() => boards.id, { onDelete: "cascade" }),
  column: text("column", { enum: ["backlog", "todo", "doing", "done"] })
    .notNull()
    .$type<ColumnType>(),
  title: text("title").notNull(),
  description: text("description").notNull().default(""),
  position: integer("position").notNull().default(0),
  createdAt: text("created_at").notNull(),
});

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

export const boardsRelations = relations(boards, ({ many }) => ({
  cards: many(cards),
}));

export const cardsRelations = relations(cards, ({ one }) => ({
  board: one(boards, { fields: [cards.boardId], references: [boards.id] }),
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
