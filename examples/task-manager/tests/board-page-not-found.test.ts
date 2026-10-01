import { expect, test } from "bun:test";
import { getBoards } from "../src/api/modules/boards/service";
import app from "../src/server";

test("a missing board returns 404 without breaking the next board page", async () => {
  const [board] = getBoards();
  if (!board) {
    throw new Error("Expected a seeded board");
  }

  const missing = await app.handle(new Request("http://localhost/board/missing-board"));
  expect(missing.status).toBe(404);
  await missing.text();

  const valid = await app.handle(new Request(`http://localhost/board/${board.id}`));
  expect(valid.status).toBe(200);
  expect(await valid.text()).toContain(board.name);
});
