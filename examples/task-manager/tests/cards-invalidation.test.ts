import { expect, test } from "bun:test";
import { api } from "../src/api";

test("editing a card through a redirect invalidates its board and card queries", async () => {
  const request = (path: string, method: string, body?: object) =>
    api.handle(
      new Request(`http://furin/api${path}`, {
        method,
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: body ? JSON.stringify(body) : undefined,
      })
    );
  const boardResponse = await request("/boards", "POST", { name: "Card invalidation test" });
  expect(boardResponse.status).toBe(200);
  const board = (await boardResponse.json()) as { id: string };
  try {
    const created = await request(`/boards/${board.id}/cards`, "POST", {
      title: "Before edit",
      column: "todo",
    });
    expect(created.status).toBe(200);
    const card = (await created.json()) as { id: string };
    const updated = await request(`/cards/${card.id}`, "POST", { title: "After edit" });
    expect(updated.status).toBe(302);
    expect(updated.headers.get("location")).toBe(`/board/${board.id}`);
    expect(JSON.parse(updated.headers.get("x-furin-queries") ?? "[]")).toEqual([
      { id: "board", scope: { boardId: board.id } },
      { id: "card", scope: { id: card.id } },
    ]);
    const read = await api.handle(new Request(`http://furin/api/cards/${card.id}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ title: "After edit" });
  } finally {
    expect((await request(`/boards/${board.id}`, "DELETE")).status).toBe(200);
  }
}, 30_000);
