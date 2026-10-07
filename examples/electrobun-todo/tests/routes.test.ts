import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDeferredNdjson } from "@teyik0/furin/link";
import { waitForChild } from "./child";

async function checkTodoRequests(filename: string) {
  const previousDatabase = process.env.FURIN_TODO_DATABASE;
  process.env.FURIN_TODO_DATABASE = filename;
  try {
    const { closeTodoBackend } = await import("../src/backend-instance");
    try {
      const { default: app } = await import("../src/server");
      try {
        const created = await app.handle(
          new Request("http://localhost/api/todos", {
            method: "POST",
            headers: { "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() },
            body: JSON.stringify({ title: "Une page, deux surfaces" }),
          })
        );
        expect(created.status).toBe(200);
        await created.arrayBuffer();
        const page = await app.handle(new Request("http://localhost/"));
        expect(page.status).toBe(200);
        expect(await page.text()).toContain("Une page, deux surfaces");
        const data = await app.handle(new Request("http://localhost/_furin/data?path=%2F"));
        if (!data.body) {
          throw new Error("Missing todo loader data");
        }
        const { syncData } = await parseDeferredNdjson(data.body, undefined);
        expect(syncData.todos).toMatchObject([
          { title: "Une page, deux surfaces", completed: false },
        ]);
      } finally {
        await app.stop(true);
      }
    } finally {
      closeTodoBackend();
    }
  } finally {
    if (previousDatabase === undefined) {
      delete process.env.FURIN_TODO_DATABASE;
    } else {
      process.env.FURIN_TODO_DATABASE = previousDatabase;
    }
  }
  expect(process.env.FURIN_TODO_DATABASE).toBe(previousDatabase);
}

test("SSR and client loader requests read the same persisted todo", async () => {
  const childDatabase = process.env.FURIN_TODO_ROUTE_TEST_DATABASE;
  if (childDatabase) {
    await checkTodoRequests(childDatabase);
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "furin-todo-route-"));
  let child: ReturnType<typeof Bun.spawn> | undefined;
  // Source imports and dev runtime state belong to the child. Reap it before
  // deleting the directory: closing SQLite alone does not release every handle.
  try {
    child = Bun.spawn(
      [process.execPath, "test", "--isolate", "--timeout", "10000", import.meta.path],
      {
        env: { ...process.env, FURIN_TODO_ROUTE_TEST_DATABASE: join(dir, "todos.sqlite") },
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
    await rm(dir, { recursive: true, force: true });
  }
}, 15_000);
