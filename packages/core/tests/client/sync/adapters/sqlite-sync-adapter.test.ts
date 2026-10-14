import { Database } from "bun:sqlite";
import { afterAll, afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqliteSync, sqliteSyncAdapter } from "../../../../src/server/sync/sqlite/index.ts";
import { testSyncAdapterConformance } from "../../../helpers/sync-adapter-conformance.ts";
import type { MigrationOutcome } from "./sqlite-migration.scenario.ts";

const database = new Database(":memory:");
migrateSqliteSync(database);
afterAll(() => database.close());
afterEach(() => setSystemTime());
let conformanceNamespace = 0;
const succeededResponseCheckPattern = /furin_sync_mutations_succeeded_response_check/;

testSyncAdapterConformance(() => {
  conformanceNamespace += 1;
  return sqliteSyncAdapter({
    database,
    namespace: `conformance-${conformanceNamespace}`,
  });
});

test("declares in-memory databases as process-local", () => {
  expect(sqliteSyncAdapter({ database, namespace: "scope" }).scope).toBe("process-local");
});

test("declares empty-filename databases as process-local", () => {
  const emptyDatabase = new Database("");
  try {
    expect(sqliteSyncAdapter({ database: emptyDatabase, namespace: "empty-scope" }).scope).toBe(
      "process-local"
    );
  } finally {
    emptyDatabase.close();
  }
});

test("concurrent workers upgrade one legacy SQLite journal without startup errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-sqlite-upgrade-"));
  const file = join(directory, "sync.sqlite");
  const legacy = new Database(file);
  legacy.run("PRAGMA journal_mode=WAL");
  migrateSqliteSync(legacy);
  legacy.run("ALTER TABLE furin_sync_changes DROP COLUMN principal_hash");
  legacy.close();
  const barrier = new SharedArrayBuffer(4);
  const state = new Int32Array(barrier);
  const workers: Worker[] = [];
  let ready = 0;
  const count = 24;
  try {
    const outcomes = await Promise.all(
      Array.from({ length: count }, () => {
        const worker = new Worker(new URL("./sqlite-migration.scenario.ts", import.meta.url));
        workers.push(worker);
        return new Promise<MigrationOutcome>((resolve, reject) => {
          worker.onmessage = (event: MessageEvent<MigrationOutcome>) => {
            if (event.data.type === "ready") {
              ready += 1;
              if (ready === count) {
                Atomics.store(state, 0, 1);
                Atomics.notify(state, 0, count);
              }
            } else {
              resolve(event.data);
            }
          };
          worker.onerror = (event) => reject(event.error ?? new Error(event.message));
          worker.postMessage({ barrier, file });
        });
      })
    );
    expect(outcomes).toEqual(Array.from({ length: count }, () => ({ type: "completed" })));
    const reopened = new Database(file);
    try {
      expect(
        reopened
          .query<{ name: string }, []>("PRAGMA table_info(furin_sync_changes)")
          .all()
          .some((column) => column.name === "principal_hash")
      ).toBe(true);
      expect(() => migrateSqliteSync(reopened)).not.toThrow();
    } finally {
      reopened.close();
    }
  } finally {
    for (const worker of workers) {
      worker.terminate();
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("persists and replays a completed mutation", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "replay" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "create-card",
    principal: "user",
  });
  expect(mutation.kind).toBe("execute");
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  const response = {
    body: new TextEncoder().encode("created"),
    headers: [["content-type", "text/plain"]] as const,
    status: 201,
  };
  await adapter.completeMutation({ invalidations: [], lease: mutation.lease, response });

  expect(
    await adapter.beginMutation({
      fingerprint: "body",
      key: "create-card",
      principal: "user",
    })
  ).toEqual({ kind: "replay", response });
});

test("rejects succeeded mutations without replay data", () => {
  expect(() =>
    database
      .query<never, [string, string, string]>(
        `INSERT INTO furin_sync_mutations (
          namespace, mutation_key, mutation_id, fingerprint, state,
          lease_expires_at, expires_at
        ) VALUES (?, ?, ?, 'fingerprint', 'succeeded', 1000, 2000)`
      )
      .run("invalid-replay", "mutation", crypto.randomUUID())
  ).toThrow(succeededResponseCheckPattern);
});

test("commits the replay response and invalidation under one cursor", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "journal" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  const completed = await adapter.completeMutation({
    invalidations: [{ kind: "path", path: "/cards", type: "page" }],
    lease: mutation.lease,
    response: { body: new Uint8Array(), headers: [], status: 204 },
  });

  expect(completed).toEqual({ cursor: "1", kind: "committed" });
  expect(await adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
    changes: [
      {
        cursor: "1",
        invalidations: [{ kind: "path", path: "/cards", type: "page" }],
      },
    ],
    cursor: "1",
    reset: false,
  });
});

test("preserves changes after the cursor exceeds the safe integer range", async () => {
  const namespace = "large-cursor";
  database
    .query<never, [string, bigint, bigint]>(
      `INSERT INTO furin_sync_streams (namespace, current_cursor, oldest_cursor)
       VALUES (?, ?, ?)`
    )
    .run(namespace, BigInt(Number.MAX_SAFE_INTEGER), BigInt(Number.MAX_SAFE_INTEGER));
  const adapter = sqliteSyncAdapter({ database, namespace });

  async function appendChange(index: number): Promise<string | undefined> {
    const mutation = await adapter.beginMutation({
      fingerprint: `body-${index}`,
      key: `mutation-${index}`,
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    const completed = await adapter.completeMutation({
      invalidations: [{ kind: "path", path: `/page-${index}`, type: "page" }],
      lease: mutation.lease,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    });
    if (completed.kind !== "committed") {
      throw new Error("Expected a committed mutation");
    }
    return completed.cursor;
  }

  expect(await appendChange(1)).toBe("9007199254740992");
  expect(await appendChange(2)).toBe("9007199254740993");
  expect(
    await adapter.readChanges({ after: String(Number.MAX_SAFE_INTEGER), limit: 10 })
  ).toMatchObject({
    changes: [{ cursor: "9007199254740992" }, { cursor: "9007199254740993" }],
    cursor: "9007199254740993",
    hasMore: false,
    reset: false,
  });
});

test("rejects another payload and releases an aborted lease", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "abort" });
  const mutation = await adapter.beginMutation({
    fingerprint: "first",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }
  expect(
    await adapter.beginMutation({
      fingerprint: "second",
      key: "update-card",
      principal: "user",
    })
  ).toEqual({ kind: "conflict", reason: "payload-mismatch" });

  await adapter.abortMutation(mutation.lease);
  expect(
    await adapter.beginMutation({
      fingerprint: "first",
      key: "update-card",
      principal: "user",
    })
  ).toMatchObject({ kind: "execute" });
});

test("keeps the fingerprint through lease takeover and releases it after retention", async () => {
  setSystemTime(new Date(1000));
  const adapter = sqliteSyncAdapter({ database, namespace: "takeover" });
  const first = await adapter.beginMutation({
    fingerprint: "first",
    key: "update-card",
    principal: "user",
  });
  if (first.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }

  setSystemTime(new Date(1000 + first.lease.leaseMs + 1));
  expect(
    await adapter.beginMutation({
      fingerprint: "second",
      key: "update-card",
      principal: "user",
    })
  ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
  const replacement = await adapter.beginMutation({
    fingerprint: "first",
    key: "update-card",
    principal: "user",
  });
  expect(replacement).toMatchObject({ kind: "execute" });
  if (replacement.kind !== "execute") {
    throw new Error("Expected a replacement mutation");
  }
  const response = { body: new Uint8Array(), headers: [], status: 204 } as const;
  expect(
    await adapter.completeMutation({ invalidations: [], lease: first.lease, response })
  ).toEqual({ kind: "lost" });
  expect(
    await adapter.completeMutation({ invalidations: [], lease: replacement.lease, response })
  ).toEqual({ cursor: undefined, kind: "committed" });

  setSystemTime(new Date(1000 + replacement.lease.leaseMs + 24 * 60 * 60 * 1000 + 2));
  expect(
    await adapter.beginMutation({
      fingerprint: "second",
      key: "update-card",
      principal: "user",
    })
  ).toMatchObject({ kind: "execute" });
});

test("coordinates reservations across two connections to one WAL file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "furin-sync-sqlite-"));
  const filename = join(directory, "sync.db");
  const firstDatabase = new Database(filename, { create: true });
  const secondDatabase = new Database(filename, { create: true });
  try {
    firstDatabase.run("PRAGMA journal_mode = WAL");
    secondDatabase.run("PRAGMA journal_mode = WAL");
    migrateSqliteSync(firstDatabase);
    const firstAdapter = sqliteSyncAdapter({ database: firstDatabase, namespace: "shared" });
    const secondAdapter = sqliteSyncAdapter({ database: secondDatabase, namespace: "shared" });
    expect(firstAdapter.scope).toBe("host-local");
    expect(secondAdapter.scope).toBe("host-local");
    const mutation = await firstAdapter.beginMutation({
      fingerprint: "body",
      key: "create-card",
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }

    expect(
      await secondAdapter.beginMutation({
        fingerprint: "body",
        key: "create-card",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "in-progress" });
    await firstAdapter.abortMutation(mutation.lease);
    expect(
      await secondAdapter.beginMutation({
        fingerprint: "body",
        key: "create-card",
        principal: "user",
      })
    ).toMatchObject({ kind: "execute" });
  } finally {
    secondDatabase.close();
    firstDatabase.close();
    rmSync(directory, { force: true, recursive: true });
  }
});

test("renews a live lease and rejects it after the renewed deadline", async () => {
  setSystemTime(new Date(1000));
  const adapter = sqliteSyncAdapter({ database, namespace: "renew" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }

  setSystemTime(new Date(1000 + mutation.lease.leaseMs - 1));
  expect(await adapter.renewMutation(mutation.lease)).toBe("renewed");
  setSystemTime(new Date(1000 + 2 * mutation.lease.leaseMs));
  expect(await adapter.renewMutation(mutation.lease)).toBe("lost");
});

test("keeps renewed in-progress mutations after retention expiry", async () => {
  setSystemTime(new Date(1000));
  const adapter = sqliteSyncAdapter({ database, namespace: "long-renew" });
  const mutation = await adapter.beginMutation({
    fingerprint: "body",
    key: "update-card",
    principal: "user",
  });
  if (mutation.kind !== "execute") {
    throw new Error("Expected an executable mutation");
  }

  setSystemTime(new Date(2000));
  expect(
    await adapter.renewMutation({
      ...mutation.lease,
      leaseMs: 25 * 60 * 60 * 1000,
    })
  ).toBe("renewed");

  setSystemTime(new Date(1000 + 24 * 60 * 60 * 1000 + 10_000));
  expect(
    await adapter.beginMutation({
      fingerprint: "body",
      key: "update-card",
      principal: "user",
    })
  ).toEqual({ kind: "conflict", reason: "in-progress" });
  expect(
    await adapter.completeMutation({
      invalidations: [],
      lease: mutation.lease,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    })
  ).toEqual({ cursor: undefined, kind: "committed" });
});

test("rejects sqlite failures through the returned promise", async () => {
  const failingDatabase = new Database(":memory:");
  const adapter = sqliteSyncAdapter({ database: failingDatabase, namespace: "closed" });
  failingDatabase.close();

  await expect(
    adapter.beginMutation({
      fingerprint: "body",
      key: "update-card",
      principal: "user",
    })
  ).rejects.toThrow();
});

test("requests a reset when retained history no longer covers the cursor", async () => {
  const adapter = sqliteSyncAdapter({ database, namespace: "retention" });
  for (let index = 0; index < 1001; index += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: cursor order is the behavior under test.
    const mutation = await adapter.beginMutation({
      fingerprint: `body-${index}`,
      key: `mutation-${index}`,
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    await adapter.completeMutation({
      invalidations: [{ kind: "path", path: `/page-${index}`, type: "page" }],
      lease: mutation.lease,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    });
  }

  expect(await adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
    changes: [],
    cursor: "1001",
    reset: true,
  });
});
