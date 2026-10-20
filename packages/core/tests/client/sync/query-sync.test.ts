import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";
import { queryTag } from "../../../src/shared/sync-query.ts";

function sqliteSync(namespace: string) {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  return {
    database,
    sync: { adapter: sqliteSyncAdapter({ database, namespace }), principal: () => "alice" },
  };
}

test("a GET is identified by its URL and a mutation invalidates the GET at its own URL", async () => {
  const { database, sync } = sqliteSync("query-sync-self");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .get("/boards/:boardId/cards", () => [{ id: "1", title: "Card" }])
    .post("/boards/:boardId/cards", { body: t.Object({ title: t.String() }) }, ({ body }) => body);
  const self = { id: "/boards/:boardId/cards", scope: { boardId: "alpha" } };
  try {
    const read = await app.handle(new Request("http://localhost/boards/alpha/cards?page=2"));
    expect(read.status).toBe(200);
    const identity = JSON.parse(read.headers.get("x-furin-query") ?? "null");
    expect(identity).toMatchObject(self);
    expect(identity.session).toBeString();
    const write = await app.handle(
      new Request("http://localhost/boards/alpha/cards", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "create" },
        body: JSON.stringify({ title: "New card" }),
      })
    );
    expect(write.status).toBe(200);
    expect(JSON.parse(write.headers.get("x-furin-queries") ?? "null")).toEqual([self]);
    const changes = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await changes.json()).toMatchObject({
      changes: [{ cursor: "1", invalidations: [{ kind: "tags", tags: [queryTag(self)] }] }],
      reset: false,
    });
  } finally {
    database.close();
  }
});

test("invalidate(pattern, params) targets other GETs, omitted params meaning every value", async () => {
  const { database, sync } = sqliteSync("query-sync-invalidate");
  const app = new Elysia()
    .use(furinSync(sync))
    .get("/boards", () => [])
    .get("/boards/:boardId", ({ params }) => ({ id: params.boardId }))
    .patch("/cards/:id", ({ invalidate }) => {
      invalidate("/boards/:boardId", { boardId: "alpha" });
      invalidate("/boards");
      return { ok: true };
    })
    .delete("/cards/:id", ({ invalidate }) => {
      invalidate("/boards/:boardId");
      return { ok: true };
    });
  const mutate = (method: string) =>
    app.handle(new Request("http://localhost/cards/c1", { method }));
  try {
    const patched = await mutate("PATCH");
    expect(JSON.parse(patched.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "/boards/:boardId", scope: { boardId: "alpha" } },
      { id: "/boards", scope: {} },
      { id: "/cards/:id", scope: { id: "c1" } },
    ]);
    const deleted = await mutate("DELETE");
    expect(JSON.parse(deleted.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "/boards/:boardId", scope: {} },
      { id: "/cards/:id", scope: { id: "c1" } },
    ]);
  } finally {
    database.close();
  }
});

test("atomic invalidations roll back with the domain write and replay with the response", async () => {
  const database = new Database(":memory:");
  database.run("CREATE TABLE atomic_cards (board_id TEXT NOT NULL)");
  migrateSqliteSync(database);
  const cards = sqliteTable("atomic_cards", { boardId: text("board_id").notNull() });
  const db = drizzle(database);
  const sync = {
    adapter: drizzleSyncAdapter({ db, namespace: "query-atomic" }),
    principal: () => "alice",
  };
  let rejectBusiness = true;
  let throwAfterInvalidate = false;
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post("/boards/:boardId/cards", ({ invalidate, mutation, params, problem }) =>
      mutation((tx) => {
        tx.insert(cards).values({ boardId: params.boardId }).run();
        invalidate("/boards/:boardId", { boardId: params.boardId });
        if (throwAfterInvalidate) {
          throw new Error("Invalid write");
        }
        return rejectBusiness
          ? problem("Conflict", { detail: "Rejected" })
          : { boardId: params.boardId };
      })
    );
  const request = () =>
    new Request("http://localhost/boards/alpha/cards", {
      method: "POST",
      headers: { "idempotency-key": "same-key" },
    });
  const board = { id: "/boards/:boardId", scope: { boardId: "alpha" } };
  const self = { id: "/boards/:boardId/cards", scope: { boardId: "alpha" } };
  try {
    const rejected = await app.handle(request());
    expect(rejected.status).toBe(409);
    expect(rejected.headers.has("x-furin-queries")).toBe(false);
    rejectBusiness = false;
    throwAfterInvalidate = true;
    expect((await app.handle(request())).status).toBe(500);
    expect(db.select().from(cards).all()).toEqual([]);
    const rolledBackChanges = await app.handle(
      new Request("http://localhost/_furin/sync/changes?after=0")
    );
    expect(await rolledBackChanges.json()).toMatchObject({ changes: [] });
    throwAfterInvalidate = false;
    const committed = await app.handle(request());
    expect(committed.status).toBe(200);
    expect(JSON.parse(committed.headers.get("x-furin-queries") ?? "null")).toEqual([board, self]);
    const replay = await app.handle(request());
    expect(replay.headers.get("x-furin-queries")).toBe(committed.headers.get("x-furin-queries"));
    expect(db.select().from(cards).all()).toEqual([{ boardId: "alpha" }]);
    const changes = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await changes.json()).toMatchObject({
      changes: [
        {
          cursor: "1",
          invalidations: [{ kind: "tags", tags: [queryTag(board), queryTag(self)] }],
        },
      ],
      reset: false,
    });
  } finally {
    database.close();
  }
});
