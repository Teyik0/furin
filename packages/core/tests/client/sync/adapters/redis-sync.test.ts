import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { RedisClient, SQL } from "bun";
import { postgresSyncAdapter } from "../../../../src/server/sync/postgres/index.ts";
import { redisSyncAdapter, redisSyncNotifier } from "../../../../src/server/sync/redis/index.ts";
import { testSyncAdapterConformance } from "../../../helpers/sync-adapter-conformance.ts";

const redisUrl = process.env.FURIN_SYNC_REDIS_URL;
const databaseUrl = process.env.FURIN_SYNC_POSTGRES_URL;
const describeWithRedis = redisUrl === undefined ? describe.skip : describe;
const describeWithBoth =
  redisUrl === undefined || databaseUrl === undefined ? describe.skip : describe;

describe("Redis sync validation", () => {
  test("rejects namespaces containing an unpaired surrogate with a validation error", () => {
    const client = new RedisClient("redis://127.0.0.1:1");

    expect(() => redisSyncAdapter({ client, namespace: "\uD800" })).toThrow(
      "[furin-sync-redis] namespace must contain valid Unicode."
    );
    client.close();
  });
});

describeWithRedis("Redis sync", () => {
  const client = new RedisClient(redisUrl as string);
  const namespace = "redis-conformance";
  const adapter = redisSyncAdapter({ client, namespace });

  beforeEach(async () => {
    const keys = await client.send("KEYS", [`furin:sync:{${encodeURIComponent(namespace)}}:*`]);
    if (Array.isArray(keys) && keys.length > 0) {
      await client.send("DEL", keys as string[]);
    }
  });

  afterAll(() => {
    client.close();
  });

  testSyncAdapterConformance(() => adapter);

  test("resets malformed stream cursors", async () => {
    expect(await adapter.readChanges({ after: "0x0-0", limit: 10 })).toEqual({
      changes: [],
      cursor: "0-0",
      hasMore: false,
      reset: true,
    });
  });

  test("continues after the last evicted stream cursor", async () => {
    let evictedCursor: string | undefined;
    for (let index = 0; index <= 1000; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: Ordered writes make the boundary deterministic.
      const mutation = await adapter.beginMutation({
        fingerprint: `fingerprint-${index}`,
        key: `mutation-${index}`,
        principal: "user",
      });
      if (mutation.kind !== "execute") {
        throw new Error("Expected an executable mutation");
      }
      const completed = await adapter.completeMutation({
        invalidations: [{ kind: "tags", tags: [`tag-${index}`] }],
        lease: mutation.lease,
        response: { body: new Uint8Array(), headers: [], status: 204 },
      });
      if (completed.kind !== "committed" || completed.cursor === undefined) {
        throw new Error("Expected a committed cursor");
      }
      evictedCursor ??= completed.cursor;
    }
    if (evictedCursor === undefined) {
      throw new Error("Expected an evicted cursor");
    }

    expect(await adapter.readChanges({ after: evictedCursor, limit: 1 })).toMatchObject({
      changes: [{ invalidations: [{ kind: "tags", tags: ["tag-1"] }] }],
      hasMore: true,
      reset: false,
    });
  });

  test("atomically persists replay response and invalidations", async () => {
    const mutation = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(mutation.kind).toBe("execute");
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    const completed = await adapter.completeMutation({
      invalidations: [{ kind: "tags", tags: ["projects"] }],
      lease: mutation.lease,
      response: {
        body: new TextEncoder().encode("created"),
        headers: [["content-type", "text/plain"]],
        status: 201,
      },
    });
    expect(completed.kind).toBe("committed");
    if (completed.kind !== "committed" || completed.cursor === undefined) {
      throw new Error("Expected a committed cursor");
    }
    expect(
      await adapter.beginMutation({
        fingerprint: "fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({
      kind: "replay",
      response: {
        body: new TextEncoder().encode("created"),
        headers: [["content-type", "text/plain"]],
        status: 201,
      },
    });
    expect(await adapter.readChanges({ after: "0-0", limit: 10 })).toEqual({
      changes: [
        {
          cursor: completed.cursor,
          invalidations: [{ kind: "tags", tags: ["projects"] }],
        },
      ],
      cursor: completed.cursor,
      hasMore: false,
      reset: false,
    });
  });

  test("rejects an old owner after takeover", async () => {
    const first = await adapter.beginMutation({
      fingerprint: "fingerprint",
      key: "mutation",
      principal: "user",
    });
    expect(first.kind).toBe("execute");
    if (first.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    const keys = await client.send("KEYS", [
      `furin:sync:{${encodeURIComponent(namespace)}}:mutation:*`,
    ]);
    if (!Array.isArray(keys) || typeof keys[0] !== "string") {
      throw new Error("Expected a mutation key");
    }
    await client.send("EVAL", [
      "local value = cjson.decode(redis.call('GET', KEYS[1])); value.leaseUntil = 0; redis.call('SET', KEYS[1], cjson.encode(value), 'PX', 86400000); return 1",
      "1",
      keys[0],
    ]);
    expect(
      await adapter.beginMutation({
        fingerprint: "other-fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toEqual({ kind: "conflict", reason: "payload-mismatch" });
    expect(
      await adapter.beginMutation({
        fingerprint: "fingerprint",
        key: "mutation",
        principal: "user",
      })
    ).toMatchObject({ kind: "execute" });
    expect(await adapter.renewMutation(first.lease)).toBe("lost");
  });

  test("notifies independently from durable storage", async () => {
    const notifier = redisSyncNotifier({ client, namespace });
    let receiveCursor: (cursor: string) => void = () => {
      throw new Error("Notifier resolved before the test was ready");
    };
    const received = new Promise<string>((resolve) => {
      receiveCursor = resolve;
    });
    const subscription = await notifier.subscribe(receiveCursor);
    await notifier.publish("42-0");
    expect(await received).toBe("42-0");
    await subscription.unsubscribe();
  });
});

describeWithBoth("PostgreSQL with Redis notifier", () => {
  const sql = new SQL(databaseUrl as string);
  const namespace = "hybrid-failure";
  const adapter = postgresSyncAdapter({ namespace, sql });

  beforeEach(async () => {
    const migration = await Bun.file(
      new URL("../../../../src/server/sync/postgres/migration.sql", import.meta.url)
    ).text();
    await sql.unsafe(migration);
    await sql`DELETE FROM furin_sync.changes WHERE namespace = ${namespace}`;
    await sql`DELETE FROM furin_sync.streams WHERE namespace = ${namespace}`;
    await sql`DELETE FROM furin_sync.mutations WHERE namespace = ${namespace}`;
  });

  afterAll(async () => {
    await sql.close();
  });

  test("recovers from the durable journal when notification fails", async () => {
    const mutation = await adapter.beginMutation({
      fingerprint: "hybrid",
      key: "hybrid",
      principal: "user",
    });
    if (mutation.kind !== "execute") {
      throw new Error("Expected an executable mutation");
    }
    const completed = await adapter.completeMutation({
      invalidations: [{ kind: "path", path: "/hybrid", type: "page" }],
      lease: mutation.lease,
      response: { body: new Uint8Array(), headers: [], status: 204 },
    });
    if (completed.kind !== "committed" || completed.cursor === undefined) {
      throw new Error("Expected a committed cursor");
    }

    const unavailableClient = new RedisClient("redis://127.0.0.1:1", {
      connectionTimeout: 100,
      enableOfflineQueue: false,
      maxRetries: 0,
    });
    const notifier = redisSyncNotifier({ client: unavailableClient, namespace });
    await expect(notifier.publish(completed.cursor)).rejects.toThrow();
    unavailableClient.close();
    expect(await adapter.readChanges({ after: "0", limit: 10 })).toMatchObject({
      changes: [
        {
          cursor: completed.cursor,
          invalidations: [{ kind: "path", path: "/hybrid", type: "page" }],
        },
      ],
      reset: false,
    });
  });
});
