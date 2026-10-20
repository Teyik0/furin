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

function post(path: string, key: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "idempotency-key": key },
  });
}

async function journal(app: { handle: (request: Request) => Promise<Response> }) {
  const response = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
  return ((await response.json()) as { changes: { invalidations: unknown[] }[] }).changes;
}

test("handler invalidate() reports and journals like a route-level invalidation", async () => {
  const { database, sync } = sqliteSync("imperative-plain");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post("/boards/:boardId/cards", ({ params, invalidate }) => {
      invalidate({ id: "board.cards", scope: { boardId: params.boardId } });
      invalidate({ path: "/board", type: "layout" });
      return { ok: true };
    });
  try {
    const response = await app.handle(post("/boards/alpha/cards", "create"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-sync")).toBe("1");
    expect(JSON.parse(response.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.cards", scope: { boardId: "alpha" } },
    ]);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "tags", tags: [queryTag({ id: "board.cards", scope: { boardId: "alpha" } })] },
          { kind: "path", path: "/board", type: "layout" },
        ],
      },
    ]);
  } finally {
    database.close();
  }
});

test("handler invalidations follow the route-level ones", async () => {
  const { database, sync } = sqliteSync("imperative-merged");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post(
      "/boards/:boardId/cards",
      {
        sync: {
          invalidate: ({ params }) => ({ id: "board.count", scope: { boardId: params.boardId } }),
        },
      },
      ({ params, invalidate }) => {
        invalidate({ id: "board.cards", scope: { boardId: params.boardId } });
        return { ok: true };
      }
    );
  try {
    const response = await app.handle(post("/boards/alpha/cards", "create"));
    expect(JSON.parse(response.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.count", scope: { boardId: "alpha" } },
      { id: "board.cards", scope: { boardId: "alpha" } },
    ]);
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "tags", tags: [queryTag({ id: "board.count", scope: { boardId: "alpha" } })] },
          { kind: "tags", tags: [queryTag({ id: "board.cards", scope: { boardId: "alpha" } })] },
        ],
      },
    ]);
  } finally {
    database.close();
  }
});

test("handler invalidations are discarded when a plain mutation fails", async () => {
  const { database, sync } = sqliteSync("imperative-plain-failure");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post("/rejected", ({ invalidate, problem }) => {
      invalidate({ id: "board.cards", scope: { boardId: "alpha" } });
      return problem("Conflict", { detail: "Rejected" });
    })
    .post("/thrown", ({ invalidate }) => {
      invalidate({ id: "board.cards", scope: { boardId: "alpha" } });
      throw new Error("Failed");
    });
  try {
    const rejected = await app.handle(post("/rejected", "rejected"));
    expect(rejected.status).toBe(409);
    expect(rejected.headers.has("x-furin-queries")).toBe(false);
    const thrown = await app.handle(post("/thrown", "thrown"));
    expect(thrown.status).toBe(500);
    expect(thrown.headers.has("x-furin-queries")).toBe(false);
    expect(await journal(app)).toEqual([]);
  } finally {
    database.close();
  }
});

test("a guard's sync option applies to every route it wraps", async () => {
  const { database, sync } = sqliteSync("guarded");
  const app = new Elysia().use(furinSync(sync)).guard(
    {
      params: t.Object({ boardId: t.String() }),
      sync: {
        invalidate: ({ params }) => ({ id: "board.cards", scope: { boardId: params.boardId } }),
      },
    },
    (guarded) =>
      guarded
        .patch("/boards/:boardId", () => ({ ok: true }))
        .delete("/boards/:boardId", () => ({ ok: true }))
        .put(
          "/boards/:boardId",
          {
            sync: {
              invalidate: ({ params }) => ({
                id: "board.count",
                scope: { boardId: params.boardId },
              }),
            },
          },
          () => ({ ok: true })
        )
  );
  const send = (method: string, boardId: string) =>
    app.handle(
      new Request(`http://localhost/boards/${boardId}`, {
        method,
        headers: { "idempotency-key": method },
      })
    );
  try {
    const patched = await send("PATCH", "alpha");
    expect(patched.status).toBe(200);
    expect(JSON.parse(patched.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.cards", scope: { boardId: "alpha" } },
    ]);
    const deleted = await send("DELETE", "beta");
    expect(deleted.status).toBe(200);
    expect(JSON.parse(deleted.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.cards", scope: { boardId: "beta" } },
    ]);
    const overridden = await send("PUT", "gamma");
    expect(JSON.parse(overridden.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.count", scope: { boardId: "gamma" } },
    ]);
  } finally {
    database.close();
  }
});

test("atomic handler invalidations commit with the transaction and roll back with it", async () => {
  const database = new Database(":memory:");
  database.run("CREATE TABLE imperative_cards (board_id TEXT NOT NULL)");
  migrateSqliteSync(database);
  const cards = sqliteTable("imperative_cards", { boardId: text("board_id").notNull() });
  const db = drizzle(database);
  const sync = {
    adapter: drizzleSyncAdapter({ db, namespace: "imperative-atomic" }),
    principal: () => "alice",
  };
  let outcome: "commit" | "problem" | "throw" = "problem";
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post(
      "/boards/:boardId/cards",
      {
        sync: {
          invalidate: ({ params }) => ({ id: "board.count", scope: { boardId: params.boardId } }),
        },
      },
      ({ mutation, params, problem, invalidate }) =>
        mutation((tx) => {
          tx.insert(cards).values({ boardId: params.boardId }).run();
          invalidate({ id: "board.cards", scope: { boardId: params.boardId } });
          invalidate({ path: "/board", type: "layout" });
          if (outcome === "throw") {
            throw new Error("Failed");
          }
          return outcome === "problem" ? problem("Conflict", { detail: "Rejected" }) : { ok: true };
        })
    );
  try {
    const rejected = await app.handle(post("/boards/alpha/cards", "rejected"));
    expect(rejected.status).toBe(409);
    expect(rejected.headers.has("x-furin-queries")).toBe(false);
    expect(rejected.headers.has("x-furin-revalidate")).toBe(false);
    outcome = "throw";
    const thrown = await app.handle(post("/boards/alpha/cards", "thrown"));
    expect(thrown.status).toBe(500);
    expect(thrown.headers.has("x-furin-queries")).toBe(false);
    expect(db.select().from(cards).all()).toEqual([]);
    expect(await journal(app)).toEqual([]);
    outcome = "commit";
    const committed = await app.handle(post("/boards/alpha/cards", "committed"));
    expect(committed.status).toBe(200);
    expect(committed.headers.get("x-furin-sync")).toBe("1");
    expect(JSON.parse(committed.headers.get("x-furin-queries") ?? "null")).toEqual([
      { id: "board.count", scope: { boardId: "alpha" } },
      { id: "board.cards", scope: { boardId: "alpha" } },
    ]);
    expect(committed.headers.get("x-furin-revalidate")).toBe("/board:layout");
    const replay = await app.handle(post("/boards/alpha/cards", "committed"));
    expect(replay.headers.get("x-furin-queries")).toBe(committed.headers.get("x-furin-queries"));
    expect(db.select().from(cards).all()).toEqual([{ boardId: "alpha" }]);
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "tags", tags: [queryTag({ id: "board.count", scope: { boardId: "alpha" } })] },
          { kind: "tags", tags: [queryTag({ id: "board.cards", scope: { boardId: "alpha" } })] },
          { kind: "path", path: "/board", type: "layout" },
        ],
      },
    ]);
  } finally {
    database.close();
  }
});
