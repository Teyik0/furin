import { describe, expect, test } from "bun:test";
import { furinSync } from "@teyik0/furin";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";

import { __resetCacheState } from "../../../packages/core/src/server/cache";
import { __resetSyncState } from "../../../packages/core/src/server/sync/stream";
import { boardPlugin } from "../src/api/modules/boards";
import { db } from "../src/db";
import { boards } from "../src/db/schema";
import { taskManagerSync } from "../src/sync";

const CREATED_BOARD_NAME = "Invalidation create test board";
const DELETED_BOARD_NAME = "Invalidation delete test board";
const boardApp = new Elysia().use(furinSync(taskManagerSync)).use(boardPlugin);

interface CreatedBoard {
  id: string;
}

function resetState() {
  __resetCacheState();
  __resetSyncState();
  db.delete(boards).where(eq(boards.name, CREATED_BOARD_NAME)).run();
  db.delete(boards).where(eq(boards.name, DELETED_BOARD_NAME)).run();
}

describe("boards API cache invalidation", () => {
  test("creating a board invalidates GET /boards, read by the index page and the board sidebar", async () => {
    resetState();
    try {
      const response = await boardApp.handle(
        new Request("http://furin/boards", {
          body: JSON.stringify({ name: CREATED_BOARD_NAME }),
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "create-board-test",
          },
          method: "POST",
        })
      );

      expect(response.status).toBe(200);
      // Self-invalidation: the GET at the mutation's own URL.
      expect(JSON.parse(response.headers.get("x-furin-queries") ?? "[]")).toEqual([
        { id: "/boards", scope: {} },
      ]);
      await response.json();
    } finally {
      resetState();
    }
  });

  test("deleting a board invalidates its own GET and the board list", async () => {
    resetState();
    try {
      const createResponse = await boardApp.handle(
        new Request("http://furin/boards", {
          body: JSON.stringify({ name: DELETED_BOARD_NAME }),
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": "create-board-before-delete-test",
          },
          method: "POST",
        })
      );
      const created = (await createResponse.json()) as CreatedBoard;

      const response = await boardApp.handle(
        new Request(`http://furin/boards/${created.id}`, {
          headers: { "Idempotency-Key": "delete-board-test" },
          method: "DELETE",
        })
      );

      expect(response.status).toBe(200);
      // This standalone plugin has no /api prefix: the explicit list target names the served app's route.
      expect(JSON.parse(response.headers.get("x-furin-queries") ?? "[]")).toEqual([
        { id: "/api/boards", scope: {} },
        { id: "/boards/:boardId", scope: { boardId: created.id } },
      ]);
      await response.json();
    } finally {
      resetState();
    }
  });
});
