import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { Elysia } from "elysia";
import type { SyncAdapter } from "../../../src/server/sync/adapter.ts";
import { furinSync } from "../../../src/server/sync/plugin.ts";
import { resolveSyncRuntime } from "../../../src/server/sync/runtime.ts";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../src/server/sync/sqlite/index.ts";
import { createSyncChangesPlugin } from "../../../src/server/sync/stream.ts";

const SECRET = "a-test-secret-of-at-least-32-characters";
const databases: Database[] = [];

function hostLocalAdapter(): SyncAdapter {
  return {
    abortMutation: async () => undefined,
    beginMutation: async () => ({ kind: "conflict", reason: "in-progress" }),
    completeMutation: async () => ({ kind: "lost" }),
    currentCursor: async () => "0",
    readChanges: async () => ({ changes: [], cursor: "0", hasMore: false, reset: false }),
    renewMutation: async () => "lost",
    scope: "host-local",
  };
}

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

function hmac(principal: string): string {
  return new Bun.CryptoHasher("sha256", SECRET).update(principal).digest("hex");
}

function syncApp(database: Database, secret: string | undefined) {
  const sync = {
    adapter: sqliteSyncAdapter({ database, namespace: "principal-secret" }),
    principal: () => "alice@example.test",
    secret,
  };
  return new Elysia()
    .use(furinSync(sync))
    .use(createSyncChangesPlugin(sync))
    .get("/cards", () => [])
    .post("/cards", { sync: { path: "/cards", type: "page" } }, () => ({ success: true }));
}

function memoryDatabase(): Database {
  const database = new Database(":memory:");
  migrateSqliteSync(database);
  databases.push(database);
  return database;
}

test("a configured secret keys the query session with HMAC-SHA256", async () => {
  const app = syncApp(memoryDatabase(), SECRET);
  const read = await app.handle(new Request("http://localhost/cards"));
  const identity = JSON.parse(read.headers.get("x-furin-query") ?? "null");
  expect(identity.session).toBe(hmac("alice@example.test"));
});

function write(app: ReturnType<typeof syncApp>, key: string) {
  return app.handle(
    new Request("http://localhost/cards", { headers: { "idempotency-key": key }, method: "POST" })
  );
}

test("the journal stores the keyed hash and recovers the writer's own changes", async () => {
  const database = memoryDatabase();
  const app = syncApp(database, SECRET);
  expect((await write(app, "one")).status).toBe(200);
  expect(
    database
      .query<{ principal_hash: string }, []>("SELECT principal_hash FROM furin_sync_changes")
      .all()
  ).toEqual([{ principal_hash: hmac("alice@example.test") }]);
  const changes = await app.handle(new Request("http://localhost/_furin/sync/changes?after=0"));
  expect(await changes.json()).toMatchObject({ changes: [{ cursor: "1" }], reset: false });
});

test("journal rows hashed before the secret was configured fall back to a reset", async () => {
  const database = memoryDatabase();
  expect((await write(syncApp(database, undefined), "before")).status).toBe(200);
  const changes = await syncApp(database, SECRET).handle(
    new Request("http://localhost/_furin/sync/changes?after=0")
  );
  expect(await changes.json()).toEqual({ changes: [], cursor: "1", hasMore: false, reset: true });
});

test("rejects secrets shorter than 32 characters", () => {
  expect(() => syncApp(memoryDatabase(), "too-short")).toThrow(
    "sync.secret must be a string of at least 32 characters"
  );
});

test("rejects runtimes sharing an adapter with a different secret", () => {
  const adapter = sqliteSyncAdapter({ database: memoryDatabase(), namespace: "shared" });
  const principal = () => "alice";
  resolveSyncRuntime({ adapter, principal, secret: SECRET }, true);
  expect(() =>
    resolveSyncRuntime({ adapter, principal, secret: `${SECRET}-rotated` }, true)
  ).toThrow("must use the same secret");
});

test("warns once per adapter in production when no secret is configured", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const keyed = hostLocalAdapter();
    resolveSyncRuntime({ adapter: keyed, principal: () => "alice", secret: SECRET }, false);
    expect(warn).not.toHaveBeenCalled();
    const unkeyed = hostLocalAdapter();
    resolveSyncRuntime({ adapter: unkeyed, principal: () => "alice" }, false);
    resolveSyncRuntime({ adapter: unkeyed, principal: () => "alice" }, false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain("sync.secret is not set");
  } finally {
    warn.mockRestore();
  }
});
