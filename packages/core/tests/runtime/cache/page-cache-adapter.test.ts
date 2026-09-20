import { expect, test } from "bun:test";
import {
  createMemoryPageCache,
  type PageCacheIdentity,
} from "../../../src/server/cache/page-cache.ts";

const identity: PageCacheIdentity = {
  buildId: "build-a",
  key: "/posts?category=frameworks",
  mode: "isr",
  path: "/posts",
  scope: "shop",
  tags: ["posts"],
};

test("a render started before path invalidation cannot publish stale HTML", async () => {
  const cache = createMemoryPageCache();
  const lease = await cache.acquire({ identity, leaseMs: 30_000 });

  expect(lease).not.toBeNull();
  if (lease === null) {
    throw new Error("Expected the render lease to be acquired");
  }

  await cache.invalidate({ kind: "path", path: "/posts", scope: "shop", type: "page" });

  expect(
    await cache.commit({
      entry: {
        cachedAt: Date.now(),
        payload: "<html>stale</html>",
        revalidate: 60,
      },
      identity,
      lease,
    })
  ).toBe("superseded");
  expect(await cache.read(identity)).toBeNull();
});

test("an expired lease owner cannot revoke or overwrite its successor", async () => {
  const cache = createMemoryPageCache();
  const first = await cache.acquire({ identity, leaseMs: 1 });
  if (first === null) {
    throw new Error("Expected the first render lease");
  }
  await Bun.sleep(2);
  const second = await cache.acquire({ identity, leaseMs: 30_000 });
  if (second === null) {
    throw new Error("Expected the successor render lease");
  }

  expect(
    await cache.commit({
      entry: { cachedAt: 1, payload: "old", revalidate: 60 },
      identity,
      lease: first,
    })
  ).toBe("superseded");
  expect(
    await cache.commit({
      entry: { cachedAt: 2, payload: "new", revalidate: 60 },
      identity,
      lease: second,
    })
  ).toBe("stored");
  expect((await cache.read(identity))?.payload).toBe("new");
});

test("path invalidation crosses build IDs without sharing their artifacts", async () => {
  const cache = createMemoryPageCache();
  const nextBuildIdentity: PageCacheIdentity = { ...identity, buildId: "build-b" };
  const firstLease = await cache.acquire({ identity, leaseMs: 30_000 });
  const nextLease = await cache.acquire({ identity: nextBuildIdentity, leaseMs: 30_000 });
  if (firstLease === null || nextLease === null) {
    throw new Error("Expected one lease per build");
  }

  await cache.commit({
    entry: { cachedAt: 1, payload: "build-a", revalidate: 60 },
    identity,
    lease: firstLease,
  });
  await cache.commit({
    entry: { cachedAt: 2, payload: "build-b", revalidate: 60 },
    identity: nextBuildIdentity,
    lease: nextLease,
  });

  expect((await cache.read(identity))?.payload).toBe("build-a");
  expect((await cache.read(nextBuildIdentity))?.payload).toBe("build-b");

  await cache.invalidate({ kind: "path", path: "/posts", scope: "shop", type: "page" });

  expect(await cache.read(identity)).toBeNull();
  expect(await cache.read(nextBuildIdentity)).toBeNull();
});
