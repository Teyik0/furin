import { beforeEach, expect, test } from "bun:test";
import { api } from "../src/api";
import { db } from "../src/db";
import { todos } from "../src/db/schema";
import { sync } from "../src/sync";

function send(method: string, path: string, body: object | undefined) {
  return api.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  );
}

function invalidatedQueries(response: Response) {
  return JSON.parse(response.headers.get("x-furin-queries") ?? "[]");
}

beforeEach(() => {
  db.delete(todos).run();
});

test("creates a trimmed todo and lists it", async () => {
  const created = await send("POST", "/api/todos", { title: "  First todo  " });

  expect(created.status).toBe(200);
  const todo = await created.json();
  expect(todo).toMatchObject({ title: "First todo", completed: false });
  expect(invalidatedQueries(created)).toEqual([{ id: "/api/todos", scope: {} }]);
  const list = await api.handle(new Request("http://localhost/api/todos"));
  expect(await list.json()).toEqual([todo]);
});

test.each([
  ["a blank title", "POST", { title: "   " }],
  ["an empty title", "POST", { title: "" }],
  ["a title over 200 characters", "POST", { title: "x".repeat(201) }],
  ["an empty patch", "PATCH", {}],
  ["an unknown patch field", "PATCH", { done: true }],
  ["a blank renamed title", "PATCH", { title: " " }],
])("rejects %s with 422 without writing", async (_, method, body) => {
  const before = await sync.adapter.currentCursor();
  const response = await send(method, method === "POST" ? "/api/todos" : "/api/todos/any", body);

  expect(response.status).toBe(422);
  expect(db.select().from(todos).all()).toEqual([]);
  expect(await sync.adapter.currentCursor()).toBe(before);
});

test("patches only the supplied fields and deletes, invalidating the list", async () => {
  const todo = await (await send("POST", "/api/todos", { title: "Original" })).json();

  const completed = await send("PATCH", `/api/todos/${todo.id}`, { completed: true });
  expect(await completed.json()).toEqual({ ...todo, completed: true });
  const renamed = await send("PATCH", `/api/todos/${todo.id}`, { title: " Renamed " });
  expect(await renamed.json()).toEqual({ ...todo, title: "Renamed", completed: true });
  const deleted = await send("DELETE", `/api/todos/${todo.id}`, undefined);
  expect(await deleted.json()).toEqual({ ok: true });

  for (const response of [completed, renamed, deleted]) {
    expect(invalidatedQueries(response)).toContainEqual({ id: "/api/todos", scope: {} });
  }
  expect(db.select().from(todos).all()).toEqual([]);
});

test.each([
  ["PATCH", { completed: true }],
  ["DELETE", undefined],
])("%s on a missing todo returns 404 without journaling", async (method, body) => {
  const before = await sync.adapter.currentCursor();
  const response = await send(method, "/api/todos/missing", body);

  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ status: 404, detail: "Todo not found" });
  expect(await sync.adapter.currentCursor()).toBe(before);
});
