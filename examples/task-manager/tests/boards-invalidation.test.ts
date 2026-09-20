import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Elysia } from "elysia";

import { __resetCacheState } from "../../../packages/core/src/server/cache";
import { __resetSyncState } from "../../../packages/core/src/server/sync/stream";
import { boardPlugin } from "../src/api/modules/boards";
import { db } from "../src/db";
import { boards } from "../src/db/schema";

const CREATED_BOARD_NAME = "Invalidation create test board";
const DELETED_BOARD_NAME = "Invalidation delete test board";
const boardApp = new Elysia().use(boardPlugin);

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
  test("creating a board invalidates both the index page and board layout sidebars", async () => {
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
      // The macro's afterHandle consumes the pending invalidations into the
      // response header — that is the contract observed by the SPA client.
      // Reading the header is the authoritative check; `consumePendingInvalidations`
      // is already drained by the macro at this point.
      expect(response.headers.get("x-furin-revalidate")).toBe("/,/rsc,/board:layout");
      await response.json();
    } finally {
      resetState();
    }
  });

  test("deleting a board invalidates both the index page and board layout sidebars", async () => {
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
      expect(response.headers.get("x-furin-revalidate")).toBe("/,/rsc,/board:layout");
      await response.json();
    } finally {
      resetState();
    }
  });
});
