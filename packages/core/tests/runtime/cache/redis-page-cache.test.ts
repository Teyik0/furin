import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";
import type { PageCacheIdentity } from "../../../src/server/cache/page-cache.ts";
import { redisPageCache } from "../../../src/server/cache/redis/index.ts";

describe("Redis page cache validation", () => {
  test("rejects an empty namespace", () => {
    const client = new RedisClient("redis://127.0.0.1:1");
    expect(() => redisPageCache({ client, namespace: "" })).toThrow(
      "[furin-page-cache-redis] namespace must not be empty."
    );
    client.close();
  });

  test("rejects an invalid retention window", () => {
    const client = new RedisClient("redis://127.0.0.1:1");
    expect(() => redisPageCache({ client, namespace: "test", retentionMs: 0 })).toThrow(
      "[furin-page-cache-redis] retentionMs must be a positive safe integer."
    );
    client.close();
  });
});

const redisUrl = process.env.FURIN_PAGE_CACHE_REDIS_URL;
const describeWithRedis = redisUrl === undefined ? describe.skip : describe;

describeWithRedis("Redis page cache", () => {
  const client = new RedisClient(redisUrl as string);
  const cache = redisPageCache({ client, namespace: "page-cache-conformance" });
  const identity: PageCacheIdentity = {
    buildId: "build-a",
    key: "/posts?category=frameworks",
    mode: "isr",
    path: "/posts",
    scope: "shop",
    tags: ["posts"],
  };

  async function makeLeaseLookLikeOlderReplica(): Promise<void> {
    const keys = await client.send("KEYS", ["furin:page:{page-cache-conformance}:lease:*"]);
    if (!Array.isArray(keys) || keys.length !== 1 || typeof keys[0] !== "string") {
      throw new Error("Expected one lease key");
    }
    const raw = await client.send("GET", [keys[0]]);
    if (typeof raw !== "string") {
      throw new Error("Expected a lease document");
    }
    const document = JSON.parse(raw) as { indexMember?: string };
    if (document.indexMember) {
      const indexes = await client.send("KEYS", ["furin:page:{page-cache-conformance}:leases:*"]);
      if (!Array.isArray(indexes) || indexes.length !== 1 || typeof indexes[0] !== "string") {
        throw new Error("Expected one lease index");
      }
      await client.send("ZREM", [indexes[0], document.indexMember]);
    }
    document.indexMember = undefined;
    await client.send("SET", [keys[0], JSON.stringify(document), "PX", "30000"]);
  }

  beforeEach(async () => {
    const keys = await client.send("KEYS", ["furin:page:{page-cache-conformance}:*"]);
    if (Array.isArray(keys) && keys.length > 0) {
      await client.send("DEL", keys as string[]);
    }
  });

  afterAll(() => {
    client.close();
  });

  test("rejects a stale commit after path invalidation", async () => {
    const lease = await cache.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    expect(
      await cache.invalidate({ kind: "path", path: "/posts", scope: "shop", type: "page" })
    ).toEqual({ invalidated: true, paths: ["/posts"] });

    expect(
      await cache.commit({
        entry: { cachedAt: Date.now(), payload: "<html>stale</html>", revalidate: 60 },
        identity,
        lease,
      })
    ).toBe("superseded");
    expect(await cache.read(identity)).toBeNull();
  });

  test("reports a tag-invalidated render started on another replica", async () => {
    const otherClient = new RedisClient(redisUrl as string);
    const otherCache = redisPageCache({ client: otherClient, namespace: "page-cache-conformance" });
    try {
      const lease = await cache.acquire({ identity, leaseMs: 30_000 });
      if (lease === null) {
        throw new Error("Expected the render lease");
      }

      expect(await otherCache.invalidate({ kind: "tags", scope: "shop", tags: ["posts"] })).toEqual(
        { invalidated: true, paths: ["/posts"] }
      );
      expect(
        await cache.commit({
          entry: { cachedAt: Date.now(), payload: "stale", revalidate: 60 },
          identity,
          lease,
        })
      ).toBe("superseded");
      expect(await otherCache.read(identity)).toBeNull();
    } finally {
      otherClient.close();
    }
  });

  test("shares entries and invalidates them by tag", async () => {
    const lease = await cache.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    const entry = {
      cachedAt: Date.now(),
      payload: "<html>fresh</html>",
      revalidate: 60,
    };

    expect(await cache.commit({ entry, identity, lease })).toBe("stored");
    expect(await cache.read(identity)).toEqual(entry);
    expect(await cache.invalidate({ kind: "tags", scope: "shop", tags: ["posts"] })).toEqual({
      invalidated: true,
      paths: ["/posts"],
    });
    expect(await cache.read(identity)).toBeNull();
  });

  test("allows only one replica to regenerate an entry", async () => {
    const first = await cache.acquire({ identity, leaseMs: 30_000 });
    const second = await cache.acquire({ identity, leaseMs: 30_000 });

    expect(first).not.toBeNull();
    expect(second).toBeNull();
    if (first !== null) {
      await cache.release({ identity, lease: first });
    }
    expect(await cache.acquire({ identity, leaseMs: 30_000 })).not.toBeNull();
  });

  test("releases a lease written by an older replica during a rolling deploy", async () => {
    const lease = await cache.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    await makeLeaseLookLikeOlderReplica();

    await cache.release({ identity, lease });

    expect(await cache.acquire({ identity, leaseMs: 30_000 })).not.toBeNull();
  });

  test("commits a lease written by an older replica during a rolling deploy", async () => {
    const lease = await cache.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    await makeLeaseLookLikeOlderReplica();

    expect(
      await cache.commit({
        entry: { cachedAt: Date.now(), payload: "legacy", revalidate: 60 },
        identity,
        lease,
      })
    ).toBe("stored");
  });

  test("supersedes an unindexed lease from an older replica after invalidation", async () => {
    const lease = await cache.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    await makeLeaseLookLikeOlderReplica();

    expect(
      await cache.invalidate({ kind: "path", path: "/posts", scope: "shop", type: "page" })
    ).toEqual({ invalidated: false, paths: [] });
    expect(
      await cache.commit({
        entry: { cachedAt: Date.now(), payload: "stale", revalidate: 60 },
        identity,
        lease,
      })
    ).toBe("superseded");
  });

  test("does not index a path when its render lease is abandoned", async () => {
    const abandonedIdentity: PageCacheIdentity = {
      ...identity,
      key: "/abandoned",
      path: "/abandoned",
    };
    const lease = await cache.acquire({ identity: abandonedIdentity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    await cache.release({ identity: abandonedIdentity, lease });

    expect(await cache.invalidate({ kind: "tags", scope: "shop", tags: ["posts"] })).toEqual({
      invalidated: false,
      paths: [],
    });
    expect(
      await cache.invalidate({ kind: "path", path: "/abandoned", scope: "shop", type: "page" })
    ).toEqual({ invalidated: false, paths: [] });
  });

  test("normalizes trailing slashes for layout invalidation", async () => {
    const childIdentity: PageCacheIdentity = {
      ...identity,
      key: "/posts/one",
      path: "/posts/one",
    };
    const lease = await cache.acquire({ identity: childIdentity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the child render lease");
    }
    await cache.commit({
      entry: { cachedAt: 1, payload: "child", revalidate: 60 },
      identity: childIdentity,
      lease,
    });

    expect(
      await cache.invalidate({ kind: "path", path: "/posts/", scope: "shop", type: "layout" })
    ).toEqual({ invalidated: true, paths: ["/posts/one"] });
    expect(await cache.read(childIdentity)).toBeNull();
  });

  test("expires entries and prunes their path and tag indexes", async () => {
    const expiring = redisPageCache({
      client,
      namespace: `page-cache-retention-${crypto.randomUUID()}`,
      retentionMs: 20,
    });
    const lease = await expiring.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the expiring render lease");
    }
    await expiring.commit({
      entry: { cachedAt: 1, payload: "expiring", revalidate: 60 },
      identity,
      lease,
    });

    await Bun.sleep(30);

    expect(await expiring.read(identity)).toBeNull();
    expect(await expiring.invalidate({ kind: "tags", scope: "shop", tags: ["posts"] })).toEqual({
      invalidated: false,
      paths: [],
    });
  });
});
