import { asc, count, eq } from "drizzle-orm";
import { db } from "@/db";
import { boards, cards } from "@/db/schema";
import {
  createCard as createCardFromCardsService,
  getCardsForBoard as getCardsForBoardFromCardsService,
} from "../cards/service";

export type { Board, BoardData, Card, ColumnType } from "@/db/schema";

import type { Board, BoardData } from "@/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Seed (only if empty)
// ---------------------------------------------------------------------------

const seedCount = db.select({ n: count() }).from(boards).get();
if ((seedCount?.n ?? 0) === 0) {
  const now = new Date().toISOString();
  const b1 = uid();
  const b2 = uid();

  db.insert(boards)
    .values([
      { id: b1, name: "Project Alpha", createdAt: now },
      { id: b2, name: "Personal Tasks", createdAt: now },
    ])
    .run();

  db.insert(cards)
    .values([
      {
        id: uid(),
        boardId: b1,
        column: "backlog",
        title: "Look into render bug in dashboard",
        description: "The dashboard chart flickers on resize — investigate root cause.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "backlog",
        title: "SOX compliance checklist",
        description: "Review and document all access control policies.",
        position: 1,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "backlog",
        title: "[SPIKE] Migrate to Bun runtime",
        description: "Evaluate performance gains of switching from Node to Bun.",
        position: 2,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "todo",
        title: "Design API schema",
        description: "Define REST endpoints and OpenAPI spec for v2.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "todo",
        title: "Set up observability",
        description: "Wire evlog adapters to Datadog and configure alerts.",
        position: 1,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "todo",
        title: "Postmortem for outage",
        description: "Write up the June 3rd incident and action items.",
        position: 2,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "doing",
        title: "Build Kanban UI",
        description: "Create reusable drag-and-drop board with framer-motion.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "doing",
        title: "Add logging to CRON jobs",
        description: "Ensure scheduled tasks emit structured events.",
        position: 1,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "done",
        title: "Project scaffolding",
        description: "Initialize Bun + Elysia + Furin monorepo.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b1,
        column: "done",
        title: "Set up DD dashboards",
        description: "Lambda listener metrics now visible in Datadog.",
        position: 1,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b2,
        column: "backlog",
        title: "Read Bun docs",
        description: "Learn about Bun.serve, Bun.build and the native test runner.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b2,
        column: "backlog",
        title: "Explore Furin routing",
        description: "Understand ISR, SSR and nested layout patterns.",
        position: 1,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b2,
        column: "todo",
        title: "Write integration tests",
        description: "Cover all API endpoints with Bun test.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b2,
        column: "doing",
        title: "Refactor context providers",
        description: "Replace prop-drilling with Zustand stores.",
        position: 0,
        createdAt: now,
      },
      {
        id: uid(),
        boardId: b2,
        column: "done",
        title: "Buy groceries",
        description: "Milk, eggs, coffee, and sourdough bread.",
        position: 0,
        createdAt: now,
      },
    ])
    .run();
}

// ---------------------------------------------------------------------------
// Boards queries
// ---------------------------------------------------------------------------

export function getBoards(): Board[] {
  return db.select().from(boards).orderBy(asc(boards.createdAt)).all();
}

export function getBoard(id: string): Board | undefined {
  return db.select().from(boards).where(eq(boards.id, id)).get() ?? undefined;
}

export function createBoard(name: string): Board {
  const board: Board = { id: uid(), name, createdAt: new Date().toISOString() };
  db.insert(boards).values(board).run();
  return board;
}

export function deleteBoard(id: string): boolean {
  const result = db.delete(boards).where(eq(boards.id, id)).returning({ id: boards.id }).all();
  return result.length > 0;
}

export function getBoardData(boardId: string): BoardData | undefined {
  const board = db.select().from(boards).where(eq(boards.id, boardId)).get();
  if (!board) {
    return undefined;
  }
  const boardCards = db
    .select()
    .from(cards)
    .where(eq(cards.boardId, boardId))
    .orderBy(asc(cards.position))
    .all();
  return { board, cards: boardCards };
}

export const createCard = createCardFromCardsService;
export const getCardsForBoard = getCardsForBoardFromCardsService;
