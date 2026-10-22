import { afterAll, expect, test } from "bun:test";
import { parseDeferredNdjson } from "@teyik0/furin/link";
import app from "../src/server";
import { sync } from "../src/sync";

afterAll(() => app.stop(true));

test("web mode exposes desktop availability and rejects native actions", async () => {
  const available = await app.handle(new Request("http://localhost/api/desktop"));
  expect(available.status).toBe(200);
  expect(await available.json()).toEqual({ available: false });

  await Promise.all(
    ["minimize", "open"].map(async (action) => {
      const response = await app.handle(
        new Request(`http://localhost/api/desktop/${action}`, { method: "POST" })
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: "Desktop unavailable" });
    })
  );
});

function create(title: string) {
  return app.handle(
    new Request("http://localhost/api/todos", {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ title }),
    })
  );
}

test("SSR and client loader requests read the persisted todos", async () => {
  expect((await create("Une page, deux surfaces")).status).toBe(200);

  const page = await app.handle(new Request("http://localhost/"));
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Une page, deux surfaces");

  const data = await app.handle(new Request("http://localhost/?_furin=data"));
  if (!data.body) {
    throw new Error("Missing loader data");
  }
  const { syncData } = await parseDeferredNdjson(data.body, undefined);
  expect(syncData.todos).toContainEqual(
    expect.objectContaining({ title: "Une page, deux surfaces", completed: false })
  );
});

test("browsers catch up on committed mutations through the change journal", async () => {
  const after = await sync.adapter.currentCursor();
  await create("Premier");
  await create("Second");

  const response = await app.handle(
    new Request(`http://localhost/_furin/sync/changes?after=${after}`)
  );
  expect(response.status).toBe(200);
  const journal: { changes: unknown[]; hasMore: boolean; reset: boolean } = await response.json();
  expect(journal).toMatchObject({ hasMore: false, reset: false });
  expect(journal.changes).toHaveLength(2);
});
