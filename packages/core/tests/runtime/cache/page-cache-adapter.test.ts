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
  await cache.release({ identity, lease: first });

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

test("layout invalidation normalizes a trailing slash", async () => {
  const cache = createMemoryPageCache();
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

test("bounds active render leases and reclaims expired capacity", async () => {
  const cache = createMemoryPageCache();
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    for (let index = 0; index < 1000; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: sequential acquisition fills the deterministic lease bound.
      const lease = await cache.acquire({
        identity: { ...identity, key: `/bounded/${index}`, path: `/bounded/${index}` },
        leaseMs: 30_000,
      });
      expect(lease).not.toBeNull();
    }
    expect(
      await cache.acquire({
        identity: { ...identity, key: "/bounded/overflow", path: "/bounded/overflow" },
        leaseMs: 30_000,
      })
    ).toBeNull();

    now += 30_001;

    expect(
      await cache.acquire({
        identity: { ...identity, key: "/bounded/reclaimed", path: "/bounded/reclaimed" },
        leaseMs: 30_000,
      })
    ).not.toBeNull();
  } finally {
    Date.now = originalNow;
  }
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
