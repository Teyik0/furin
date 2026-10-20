import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { getCache } from "../../../src/cache.ts";
import {
  type RuntimeCache,
  resetRuntimeCacheProvider,
  setRuntimeCacheProvider,
} from "../../../src/server/cache/runtime-cache.ts";

afterEach(() => {
  setSystemTime();
  resetRuntimeCacheProvider();
});

describe("runtime cache", () => {
  test("reclaims unread expired entries before evicting a live value in another namespace", async () => {
    const namespace = crypto.randomUUID();
    const now = Date.now();
    setSystemTime(now);
    const live = getCache({ namespace: `${namespace}-live` });
    const expired = getCache({ namespace: `${namespace}-expired` });
    await live.set("keep", "live", { ttl: 3600 });
    for (let index = 0; index < 999; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: LRU insertion order is under test.
      await expired.set(`value-${index}`, index, { ttl: 1 });
    }
    await expired.set("value-0", "renewed", { ttl: 3600 });
    await expired.delete("value-1");
    await expired.set("value-1", "replacement", { ttl: 3600 });
    setSystemTime(now + 2000);
    await getCache({ namespace: `${namespace}-new` }).set("fresh", "fresh");
    expect(await live.get("keep")).toBe("live");
    expect(await expired.get("value-0")).toBe("renewed");
    expect(await expired.get("value-1")).toBe("replacement");
    expect(await expired.get("value-998")).toBeNull();
  });
  test("bounds memory across namespaces and preserves recently read values", async () => {
    const first = getCache({ namespace: "bounded-first" });
    await first.set("value", "kept", { tags: ["bounded"] });
    for (let index = 0; index < 1000; index += 1) {
      // biome-ignore lint/performance/noAwaitInLoops: verify insertion and access ordering.
      await getCache({ namespace: `bounded-${index}` }).set("value", index);
      if (index === 500) {
        expect(await first.get("value")).toBe("kept");
      }
    }
    expect(await first.get("value")).toBe("kept");
    expect(await getCache({ namespace: "bounded-0" }).get("value")).toBeNull();
    await first.set("immediately-expired", "stale", { ttl: 0 });
    await first.set("already-expired", "stale", { ttl: -1 });
    await first.set("infinitely-expired", "stale", { ttl: Number.NEGATIVE_INFINITY });
    expect(await getCache({ namespace: "bounded-1" }).get("value")).toBe(1);
    expect(await first.get("infinitely-expired")).toBeNull();
    const recreated = getCache({ namespace: "bounded-0" });
    await recreated.set("value", "replacement", { tags: ["bounded"] });
    await first.expireTag("bounded");
    expect(await first.get("value")).toBeNull();
    expect(await recreated.get("value")).toBeNull();
  });
  test("renewal, deletion and tag expiration cannot expire replacement values", async () => {
    const cache = getCache({ namespace: crypto.randomUUID() });
    const now = Date.now();
    setSystemTime(now);
    await cache.set("later", "later", { ttl: 30 });
    await cache.set("first", "first", { ttl: 1 });
    await cache.set("renewed", "original", { ttl: 1 });
    await cache.set("renewed", "updated", { ttl: 20 });
    await cache.set("deleted", "original", { ttl: 1 });
    await cache.delete("deleted");
    await cache.set("deleted", "replacement", { ttl: 25 });
    await cache.set("tagged", "original", { tags: ["replace-tag"], ttl: 1 });
    await cache.expireTag("replace-tag");
    await cache.set("tagged", "replacement", { ttl: 15 });
    setSystemTime(now + 2000);
    await cache.set("trigger", true);
    expect(await cache.get("first")).toBeNull();
    expect(await cache.get("renewed")).toBe("updated");
    expect(await cache.get("deleted")).toBe("replacement");
    expect(await cache.get("tagged")).toBe("replacement");
    setSystemTime(now + 16_000);
    await cache.set("trigger", true);
    expect(await cache.get("tagged")).toBeNull();
    expect(await cache.get("later")).toBe("later");
    setSystemTime(now + 21_000);
    await cache.set("trigger", true);
    expect(await cache.get("renewed")).toBeNull();
    expect(await cache.get("deleted")).toBe("replacement");
    setSystemTime(now + 31_000);
    await cache.set("trigger", true);
    expect(await cache.get("deleted")).toBeNull();
    expect(await cache.get("later")).toBeNull();
  });
  test("uses the provider installed after a cache handle was created", async () => {
    const cache = getCache({ namespace: "provider-switch" });
    const values = new Map<string, unknown>();
    const providerCache: RuntimeCache = {
      delete(key) {
        values.delete(key);
        return Promise.resolve();
      },
      expireTag() {
        return Promise.resolve();
      },
      get(key) {
        return Promise.resolve(values.get(key) ?? null);
      },
      set(key, value) {
        values.set(key, value);
        return Promise.resolve();
      },
    };

    setRuntimeCacheProvider({
      getCache(options) {
        expect(options).toEqual({ namespace: "provider-switch" });
        return providerCache;
      },
    });
    await cache.set("city", "Bayonne");

    expect(await cache.get("city")).toBe("Bayonne");
  });

  test("provides TTL and tag invalidation in the default memory provider", async () => {
    const cache = getCache({ namespace: "memory-behavior" });
    const siblingCache = getCache({ namespace: "memory-sibling" });
    await cache.set("forecast", { temperature: 22 }, { tags: ["weather"], ttl: 60 });
    await siblingCache.set("forecast", { temperature: 18 }, { tags: ["weather"], ttl: 60 });
    await cache.set("expired", "stale", { ttl: 0 });

    expect(await cache.get("forecast")).toEqual({ temperature: 22 });
    expect(await cache.get("expired")).toBeNull();

    await cache.expireTag("weather");
    expect(await cache.get("forecast")).toBeNull();
    expect(await siblingCache.get("forecast")).toBeNull();
  });
});
