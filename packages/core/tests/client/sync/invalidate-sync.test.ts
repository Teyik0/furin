import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { invalidateSync } from "../../../src/furin.ts";
import { autoInvalidateRegistry } from "../../../src/server/auto-invalidate/index.ts";
import { __resetCacheState, isrCache, setISRCache } from "../../../src/server/cache/index.ts";
import type { SyncNotifier } from "../../../src/server/sync/adapter.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";
import { queryTag, queryTags } from "../../../src/shared/sync-query.ts";

afterEach(() => {
  __resetCacheState();
  autoInvalidateRegistry.reset();
});

function sqliteSync(namespace: string) {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  const published: string[] = [];
  const notifier: SyncNotifier = {
    publish: (cursor) => {
      published.push(cursor);
      return Promise.resolve();
    },
    subscribe: () => Promise.resolve({ unsubscribe: () => Promise.resolve() }),
  };
  return {
    database,
    published,
    sync: {
      adapter: sqliteSyncAdapter({ database, namespace }),
      notifier,
      principal: () => "alice",
    },
  };
}

const board = { id: "/boards/:boardId", scope: { boardId: "alpha" } };

test("invalidateSync() journals the GET URL outside a request and wakes subscribers", async () => {
  const { database, published, sync } = sqliteSync("invalidate-sync-journal");
  const app = new Elysia().use(furinSync(sync)).use(createSyncChangesPlugin(sync));
  try {
    await invalidateSync(sync, "/boards/:boardId", { boardId: "alpha" });

    expect(await sync.adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
      changes: [{ cursor: "1", invalidations: [{ kind: "tags", tags: [queryTag(board)] }] }],
    });
    expect(published).toEqual(["1"]);
    // No principal owns the change: every reader refreshes its authorized reads.
    const changes = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
    expect(await changes.json()).toEqual({ changes: [], cursor: "1", hasMore: false, reset: true });
  } finally {
    database.close();
  }
});

test("invalidateSync() purges the pages built from the GET, for every value of an omitted param", async () => {
  const { database, sync } = sqliteSync("invalidate-sync-pages");
  const entry = { generatedAt: Date.now(), html: "board", ndjson: "{}\n", revalidate: 60 };
  setISRCache("/board/alpha", entry);
  setISRCache("/board/beta", entry);
  autoInvalidateRegistry.registerLoaderTags("/board/alpha", queryTags(board));
  autoInvalidateRegistry.registerLoaderTags(
    "/board/beta",
    queryTags({ id: "/boards/:boardId", scope: { boardId: "beta" } })
  );
  try {
    await invalidateSync(sync, "/boards/:boardId", { boardId: "alpha" });
    expect(isrCache.has("/board/alpha")).toBe(false);
    expect(isrCache.has("/board/beta")).toBe(true);

    await invalidateSync(sync, "/boards/:boardId");
    expect(isrCache.has("/board/beta")).toBe(false);
  } finally {
    database.close();
  }
});

test("invalidateSync() accepts cache tags, like the handler's invalidate()", async () => {
  const { database, published, sync } = sqliteSync("invalidate-sync-tags");
  const entry = { generatedAt: Date.now(), html: "stats", ndjson: "{}\n", revalidate: 60 };
  setISRCache("/stats", entry);
  autoInvalidateRegistry.registerLoaderTags("/stats", ["board-count"]);
  try {
    await invalidateSync(sync, { tags: ["board-count"] });

    expect(isrCache.has("/stats")).toBe(false);
    expect(await sync.adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
      changes: [{ cursor: "1", invalidations: [{ kind: "tags", tags: ["board-count"] }] }],
    });
    expect(published).toEqual(["1"]);
  } finally {
    database.close();
  }
});

test("invalidateSync() accepts a page path and journals it for clients", async () => {
  const { database, sync } = sqliteSync("invalidate-sync-path");
  setISRCache("/board/alpha", {
    generatedAt: Date.now(),
    html: "board",
    ndjson: "{}\n",
    revalidate: 60,
  });
  try {
    await invalidateSync(sync, { path: "/board/alpha", type: "page" });

    expect(isrCache.has("/board/alpha")).toBe(false);
    expect(await sync.adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
      changes: [{ invalidations: [{ kind: "path", path: "/board/alpha", type: "page" }] }],
    });
  } finally {
    database.close();
  }
});

test("a background invalidation with explicit provenance is targeted only for that principal", async () => {
  const { database, sync } = sqliteSync("invalidate-sync-principal");
  const alice = new Elysia().use(createSyncChangesPlugin(sync));
  const bob = new Elysia().use(createSyncChangesPlugin({ ...sync, principal: () => "bob" }));
  try {
    await invalidateSync(sync, "/boards/:boardId", { boardId: "alpha" }, { principal: "alice" });
    const request = new Request("http://localhost/_furin/sync/changes?after=0");
    expect(await (await alice.handle(request.clone())).json()).toMatchObject({
      changes: [{ cursor: "1", invalidations: [{ kind: "tags", tags: [queryTag(board)] }] }],
      reset: false,
    });
    expect(await (await bob.handle(request.clone())).json()).toEqual({
      changes: [],
      cursor: "1",
      hasMore: false,
      reset: true,
    });
    await invalidateSync(sync, { tags: ["private-tag"] }, { principal: "alice" });
    expect(await (await alice.handle(request.clone())).json()).toMatchObject({
      changes: [
        { cursor: "1" },
        { cursor: "2", invalidations: [{ kind: "tags", tags: ["private-tag"] }] },
      ],
      reset: false,
    });
    await expect(
      invalidateSync(sync, { tags: ["private-tag"] }, { principal: "" })
    ).rejects.toThrow("principal");
  } finally {
    database.close();
  }
});
