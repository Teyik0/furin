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

  beforeEach(async () => {
    await client.send("FLUSHDB", []);
  });

  afterAll(() => {
    client.close();
  });

  test("rejects a stale commit after path invalidation", async () => {
    const lease = await cache.acquire({ identity, leaseMs: 30_000 });
    if (lease === null) {
      throw new Error("Expected the render lease");
    }
    await cache.invalidate({ kind: "path", path: "/posts", scope: "shop", type: "page" });

    expect(
      await cache.commit({
        entry: { cachedAt: Date.now(), payload: "<html>stale</html>", revalidate: 60 },
        identity,
        lease,
      })
    ).toBe("superseded");
    expect(await cache.read(identity)).toBeNull();
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
});
