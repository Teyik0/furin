import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { Elysia, t } from "elysia";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
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

const board = { id: "/boards/:boardId", scope: { boardId: "alpha" } };
const self = { id: "/boards/:boardId/cards", scope: { boardId: "alpha" } };

test("handler invalidate() reports and journals before the route's own URL", async () => {
  const { database, sync } = sqliteSync("imperative-plain");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post("/boards/:boardId/cards", ({ params, invalidate }) => {
      invalidate({ path: "/board", type: "layout" });
      invalidate("/boards/:boardId", { boardId: params.boardId });
      return { ok: true };
    });
  try {
    const response = await app.handle(post("/boards/alpha/cards", "create"));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-furin-sync")).toBe("1");
    expect(JSON.parse(response.headers.get("x-furin-queries") ?? "null")).toEqual([board, self]);
    expect(response.headers.get("x-furin-revalidate")).toBe("/board:layout");
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "path", path: "/board", type: "layout" },
          { kind: "tags", tags: [queryTag(board), queryTag(self)] },
        ],
      },
    ]);
  } finally {
    database.close();
  }
});

test("handler invalidate() accepts cache tags beside GET URLs", async () => {
  const { database, sync } = sqliteSync("imperative-merged");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .post("/boards/:boardId/cards", ({ params, invalidate }) => {
      invalidate({ tags: ["board-count"] });
      invalidate("/boards/:boardId", { boardId: params.boardId });
      return { ok: true };
    });
  try {
    const response = await app.handle(post("/boards/alpha/cards", "create"));
    expect(JSON.parse(response.headers.get("x-furin-queries") ?? "null")).toEqual([board, self]);
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "tags", tags: ["board-count"] },
          { kind: "tags", tags: [queryTag(board), queryTag(self)] },
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
      invalidate("/boards/:boardId", { boardId: "alpha" });
      return problem("Conflict", { detail: "Rejected" });
    })
    .post("/thrown", ({ invalidate }) => {
      invalidate("/boards/:boardId", { boardId: "alpha" });
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

test("idempotent: false runs every request and still invalidates, journals and broadcasts", async () => {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  const published: string[] = [];
  const sync = {
    adapter: sqliteSyncAdapter({ database, namespace: "non-idempotent" }),
    notifier: {
      publish: (cursor: string) => {
        published.push(cursor);
        return Promise.resolve();
      },
      subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
    },
    principal: () => "alice",
  };
  let calls = 0;
  const app = new Elysia()
    .use(furinSync(sync))
    .post("/boards/:boardId/cards", { idempotent: false }, ({ params, invalidate }) => {
      calls += 1;
      invalidate("/boards/:boardId", { boardId: params.boardId });
      return { calls };
    })
    .post("/atomic", { idempotent: false }, ({ mutation }) => mutation(() => ({ ok: true })));
  // A binary upload cannot be replayed: idempotent routes answer 415.
  const upload = () =>
    app.handle(
      new Request("http://localhost/boards/alpha/cards", {
        method: "POST",
        headers: { "content-type": "application/octet-stream", "idempotency-key": "same" },
        body: new Uint8Array([1, 2, 3]),
      })
    );
  try {
    const first = await upload();
    const second = await upload();
    expect(await first.json()).toEqual({ calls: 1 });
    expect(await second.json()).toEqual({ calls: 2 });
    expect(JSON.parse(second.headers.get("x-furin-queries") ?? "null")).toEqual([board, self]);
    const invalidations = [{ kind: "tags" as const, tags: [queryTag(board), queryTag(self)] }];
    expect((await sync.adapter.readChanges({ after: "0", limit: 10 })).changes).toEqual([
      { cursor: "1", invalidations },
      { cursor: "2", invalidations },
    ]);
    expect(published).toEqual(["1", "2"]);
    expect((await app.handle(post("/atomic", "atomic"))).status).toBe(500);
  } finally {
    database.close();
  }
});

test("invalidate() calls from a guard hook and from the handler add up", async () => {
  const { database, sync } = sqliteSync("guarded");
  const app = new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .guard(
      {
        params: t.Object({ boardId: t.String() }),
        beforeHandle: ({ invalidate }) => {
          invalidate({ path: "/board", type: "layout" });
        },
      },
      (guarded) =>
        guarded.patch("/boards/:boardId", ({ invalidate }) => {
          invalidate({ tags: ["board-count"] });
          return { ok: true };
        })
    );
  try {
    const patched = await app.handle(
      new Request("http://localhost/boards/alpha", {
        method: "PATCH",
        headers: { "idempotency-key": "patch" },
      })
    );
    expect(patched.status).toBe(200);
    expect(patched.headers.get("x-furin-revalidate")).toBe("/board:layout");
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "path", path: "/board", type: "layout" },
          { kind: "tags", tags: ["board-count"] },
          {
            kind: "tags",
            tags: [queryTag({ id: "/boards/:boardId", scope: { boardId: "alpha" } })],
          },
        ],
      },
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
    .post("/boards/:boardId/cards", ({ mutation, params, problem, invalidate }) =>
      mutation((tx) => {
        tx.insert(cards).values({ boardId: params.boardId }).run();
        invalidate({ path: "/board", type: "layout" });
        invalidate("/boards/:boardId", { boardId: params.boardId });
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
    expect(JSON.parse(committed.headers.get("x-furin-queries") ?? "null")).toEqual([board, self]);
    expect(committed.headers.get("x-furin-revalidate")).toBe("/board:layout");
    const replay = await app.handle(post("/boards/alpha/cards", "committed"));
    expect(replay.headers.get("x-furin-queries")).toBe(committed.headers.get("x-furin-queries"));
    expect(db.select().from(cards).all()).toEqual([{ boardId: "alpha" }]);
    expect(await journal(app)).toMatchObject([
      {
        invalidations: [
          { kind: "path", path: "/board", type: "layout" },
          { kind: "tags", tags: [queryTag(board), queryTag(self)] },
        ],
      },
    ]);
  } finally {
    database.close();
  }
});

function errorMessage(call: () => void): string | undefined {
  try {
    call();
  } catch (error) {
    return (error as Error).message;
  }
}

test("invalidate() throws in a GET handler: only mutations invalidate", async () => {
  const { database, sync } = sqliteSync("invalidate-in-get");
  const app = new Elysia()
    .use(furinSync(sync))
    .get("/boards", ({ invalidate }) => ({ error: errorMessage(() => invalidate("/boards")) }));
  try {
    const response = await app.handle(new Request("http://localhost/boards"));
    expect(await response.json()).toEqual({
      error: "[furin] invalidate() was called while handling a GET: only a mutation invalidates.",
    });
  } finally {
    database.close();
  }
});

test("invalidate() after mutation() resolved throws in development and is dropped in production", async () => {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  const sync = {
    adapter: drizzleSyncAdapter({ db: drizzle(database), namespace: "invalidate-late" }),
    principal: () => "alice",
  };
  const app = new Elysia()
    .use(furinSync(sync))
    .post("/boards", async ({ mutation, invalidate }) => {
      await mutation(() => ({ ok: true }));
      return { error: errorMessage(() => invalidate("/cards")) };
    });
  const originalDevMode = IS_DEV;
  try {
    const development = await app.handle(post("/boards", "development"));
    expect(await development.json()).toEqual({
      error:
        "[furin] invalidate() was called after mutation() resolved: call it inside the mutation() callback to commit it with the transaction.",
    });
    __setDevMode(false);
    const production = await app.handle(post("/boards", "production"));
    expect(await production.json()).toEqual({});
  } finally {
    __setDevMode(originalDevMode);
    database.close();
  }
});
