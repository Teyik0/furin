import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSyncChangesPlugin, furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { createTodoBackend } from "../src/todo-backend";
import { waitForChild } from "./child";

test("creates a trimmed todo and lists it through the API", async () => {
  const backend = createTodoBackend(":memory:");
  try {
    const response = await backend.api.handle(
      new Request("http://localhost/api/todos", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "first" },
        body: JSON.stringify({ title: "  First todo  " }),
      })
    );
    expect(response.status).toBe(200);
    const todo = await response.json();
    expect(todo).toMatchObject({ title: "First todo", completed: false });
    expect(todo.id).toBeString();
    expect(new Date(todo.createdAt).toISOString()).toBe(todo.createdAt);
    const list = await backend.api.handle(new Request("http://localhost/api/todos"));
    expect(await list.json()).toEqual([todo]);
    expect(backend.list()).toEqual([todo]);
    expect(JSON.parse(list.headers.get("x-furin-query") ?? "null")).toMatchObject({
      id: "nativeTodos",
      scope: {},
    });
  } finally {
    backend.close();
  }
}, 5000);

test("rejects invalid titles and empty patches as Problems without writing", async () => {
  const backend = createTodoBackend(":memory:");
  try {
    for (const title of ["", "   ", "x".repeat(201)]) {
      // biome-ignore lint/performance/noAwaitInLoops: exercise SQLite writes sequentially
      const response = await backend.api.handle(
        new Request("http://localhost/api/todos", {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ title }),
        })
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({ status: 422 });
    }
    const patch = await backend.api.handle(
      new Request("http://localhost/api/todos/missing", {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": "empty" },
        body: "{}",
      })
    );
    expect(patch.status).toBe(422);
    expect(backend.list()).toEqual([]);
  } finally {
    backend.close();
  }
}, 5000);

test("patches only supplied fields and deletes with journal and page invalidations", async () => {
  const backend = createTodoBackend(":memory:");
  const app = new Elysia()
    .use(furinSync(backend.sync))
    .use(backend.api)
    .use(createSyncChangesPlugin(backend.sync));
  const write = (path: string, method: string, body: object | undefined) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    );
  try {
    const before = await backend.sync.adapter.currentCursor();
    const created = await write("/api/todos", "POST", { title: "Original" });
    const todo = await created.json();
    const completed = await write(`/api/todos/${todo.id}`, "PATCH", { completed: true });
    expect(completed.status).toBe(200);
    expect(await completed.json()).toEqual({ ...todo, completed: true });
    const renamed = await write(`/api/todos/${todo.id}`, "PATCH", { title: "  Renamed " });
    expect(await renamed.json()).toEqual({ ...todo, title: "Renamed", completed: true });
    const both = await write(`/api/todos/${todo.id}`, "PATCH", { title: "Both", completed: false });
    expect(await both.json()).toEqual({ ...todo, title: "Both", completed: false });
    const deleted = await write(`/api/todos/${todo.id}`, "DELETE", undefined);
    expect(await deleted.json()).toEqual({ ok: true });
    for (const response of [created, completed, renamed, both, deleted]) {
      expect(JSON.parse(response.headers.get("x-furin-queries") ?? "null")).toEqual([
        { id: "nativeTodos", scope: {} },
      ]);
      expect(response.headers.get("x-furin-revalidate")).toContain("/");
    }
    expect(backend.list()).toEqual([]);
    const changes = await app.handle(
      new Request(`http://localhost/_furin/sync/changes?after=${before}`)
    );
    expect(changes.status).toBe(200);
    expect(await changes.json()).toMatchObject({ reset: true, changes: [], hasMore: false });
    const journal = await backend.sync.adapter.readChanges({ after: before, limit: 20 });
    expect(journal.changes).toHaveLength(5);
    for (const change of journal.changes) {
      expect(change.invalidations).toContainEqual({ kind: "path", path: "/", type: "page" });
    }
    const cursor = await backend.sync.adapter.currentCursor();
    for (const method of ["PATCH", "DELETE"]) {
      // biome-ignore lint/performance/noAwaitInLoops: exercise SQLite writes sequentially
      const missing = await write(
        "/api/todos/missing",
        method,
        method === "PATCH" ? { completed: true } : undefined
      );
      expect(missing.status).toBe(404);
      expect(await missing.json()).toMatchObject({ status: 404 });
    }
    expect(await backend.sync.adapter.currentCursor()).toBe(cursor);
  } finally {
    backend.close();
  }
}, 5000);

async function checkTodoPersistence(filename: string) {
  let backend: ReturnType<typeof createTodoBackend> | undefined;
  const request = () =>
    new Request("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "persisted-key" },
      body: JSON.stringify({ title: "Persistent" }),
    });
  try {
    backend = createTodoBackend(filename);
    const first = await backend.api.handle(request());
    expect(first.status).toBe(200);
    const todo = await first.json();
    const replay = await backend.api.handle(request());
    expect(await replay.json()).toEqual(todo);
    expect(backend.list()).toEqual([todo]);
    const cursor = await backend.sync.adapter.currentCursor();
    backend.close();
    backend = createTodoBackend(filename);
    const list = await backend.api.handle(new Request("http://localhost/api/todos"));
    expect(await list.json()).toEqual([todo]);
    const reopenedReplay = await backend.api.handle(request());
    expect(reopenedReplay.status).toBe(200);
    expect(await reopenedReplay.json()).toEqual(todo);
    expect(reopenedReplay.headers.get("x-furin-queries")).toBe(
      first.headers.get("x-furin-queries")
    );
    expect(await backend.sync.adapter.currentCursor()).toBe(cursor);
    expect(backend.list()).toEqual([todo]);
  } finally {
    backend?.close();
  }
}

test("persists todos and replays an idempotent creation after reopening SQLite", async () => {
  const childDatabase = process.env.FURIN_TODO_BACKEND_TEST_DATABASE;
  if (childDatabase) {
    await checkTodoPersistence(childDatabase);
    return;
  }
  const directory = await mkdtemp(join(tmpdir(), "native-todos-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // The child owns SQLite and its prepared statements. Reap it before deleting
    // the directory, even if backend construction or a persistence assertion fails.
    child = Bun.spawn(
      [
        process.execPath,
        "test",
        "--isolate",
        "--timeout",
        "10000",
        import.meta.path,
        "-t",
        "persists todos and replays an idempotent creation after reopening SQLite",
      ],
      {
        env: {
          ...process.env,
          FURIN_TODO_BACKEND_TEST_DATABASE: join(directory, "todos.sqlite"),
        },
        stdout: "inherit",
        stderr: "inherit",
      }
    );
    expect(await waitForChild(child, 12_000)).toBe(0);
  } finally {
    if (child) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
