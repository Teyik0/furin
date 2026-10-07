import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeferredNdjson } from "@teyik0/furin/link";

test("SSR and client loader requests read the same persisted todo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "furin-todo-route-"));
  const previousDatabase = process.env.FURIN_TODO_DATABASE;
  process.env.FURIN_TODO_DATABASE = join(dir, "todos.sqlite");
  const { default: app } = await import("../src/server");
  const { closeTodoBackend } = await import("../src/backend-instance");
  try {
    const created = await app.handle(
      new Request("http://localhost/api/todos", {
        method: "POST",
        headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ title: "Une page, deux surfaces" }),
      })
    );
    expect(created.status).toBe(200);
    const page = await app.handle(new Request("http://localhost/"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Une page, deux surfaces");
    const data = await app.handle(new Request("http://localhost/_furin/data?path=%2F"));
    if (!data.body) {
      throw new Error("Missing todo loader data");
    }
    const { syncData } = await parseDeferredNdjson(data.body, undefined);
    expect(syncData.todos).toMatchObject([{ title: "Une page, deux surfaces", completed: false }]);
  } finally {
    await app.stop(true);
    closeTodoBackend();
    if (previousDatabase === undefined) {
      delete process.env.FURIN_TODO_DATABASE;
    } else {
      process.env.FURIN_TODO_DATABASE = previousDatabase;
    }
    // Windows can briefly retain a closed SQLite file or directory handle.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
