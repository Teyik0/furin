import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import { drizzleSyncAdapter } from "../../../src/server/sync/drizzle/index.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";

test("identified GETs and committed mutations share a board-scoped identity", async () => {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  const sync = {
    adapter: sqliteSyncAdapter({ database, namespace: "query-sync" }),
    principal: () => "alice",
  };
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .get(
      "/boards/:boardId/cards",
      {
        sync: { id: "board.cards", scope: ({ params }) => ({ boardId: params.boardId }) },
      },
      () => [{ id: "1", title: "Card" }]
    )
    .post(
      "/boards/:boardId/cards",
      {
        body: t.Object({ title: t.String() }),
        sync: {
          invalidate: ({ params }) => [{ id: "board.cards", scope: { boardId: params.boardId } }],
        },
      },
      ({ body }) => body
    );
  try {
    const read = await app.handle(new Request("http://localhost/boards/alpha/cards"));
    expect(read.status).toBe(200);
    const identity = JSON.parse(read.headers.get("x-furin-query") ?? "null");
    expect(identity).toMatchObject({ id: "board.cards", scope: { boardId: "alpha" } });
    expect(identity.session).toBeString();
    const write = await app.handle(
      new Request("http://localhost/boards/alpha/cards", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "create" },
        body: JSON.stringify({ title: "New card" }),
      })
    );
    expect(write.status).toBe(200);
    expect(JSON.parse(write.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.cards", scope: { boardId: "alpha" } },
    ]);
    const changes = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await changes.json()).toMatchObject({
      changes: [
        { invalidations: [], queries: [{ id: "board.cards", scope: { boardId: "alpha" } }] },
      ],
    });
  } finally {
    database.close();
  }
});

test("atomic query invalidations roll back with the domain write and replay without reselecting dependencies", async () => {
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
  let rejectSelector = false;
  let selections = 0;
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post(
      "/cards/:boardId",
      {
        sync: {
          invalidate: ({ responseValue }) => {
            selections += 1;
            if (rejectSelector) {
              throw new Error("Invalid dependency");
            }
            if (
              !responseValue ||
              typeof responseValue !== "object" ||
              !("boardId" in responseValue) ||
              typeof responseValue.boardId !== "string"
            ) {
              throw new Error("Missing business result");
            }
            return { id: "board.cards", scope: { boardId: responseValue.boardId } };
          },
        },
      },
      ({ mutation, params, problem }) =>
        mutation((tx) => {
          tx.insert(cards).values({ boardId: params.boardId }).run();
          return rejectBusiness
            ? problem("Conflict", { detail: "Rejected" })
            : { boardId: params.boardId };
        })
    );
  const request = () =>
    new Request("http://localhost/cards/alpha", {
      method: "POST",
      headers: { "idempotency-key": "same-key" },
    });
  try {
    const rejected = await app.handle(request());
    expect(rejected.status).toBe(409);
    expect(rejected.headers.has("x-furin-queries")).toBe(false);
    expect(selections).toBe(0);
    rejectBusiness = false;
    rejectSelector = true;
    expect((await app.handle(request())).status).toBe(500);
    expect(db.select().from(cards).all()).toEqual([]);
    const rolledBackChanges = await app.handle(
      new Request("http://localhost/_furin/sync/changes?after=0")
    );
    expect(await rolledBackChanges.json()).toMatchObject({ changes: [] });
    rejectSelector = false;
    const committed = await app.handle(request());
    expect(committed.status).toBe(200);
    const replay = await app.handle(request());
    expect(replay.headers.get("x-furin-queries")).toBe(committed.headers.get("x-furin-queries"));
    expect(db.select().from(cards).all()).toEqual([{ boardId: "alpha" }]);
    expect(selections).toBe(2);
    const changes = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await changes.json()).toMatchObject({
      changes: [{ queries: [{ id: "board.cards", scope: { boardId: "alpha" } }] }],
    });
  } finally {
    database.close();
  }
});
