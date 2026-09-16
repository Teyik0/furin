import { afterEach, describe, expect, test } from "bun:test";
import { getCache } from "../../../src/cache.ts";
import {
  type RuntimeCache,
  resetRuntimeCacheProvider,
  setRuntimeCacheProvider,
} from "../../../src/server/cache/runtime-cache.ts";

afterEach(() => {
  resetRuntimeCacheProvider();
});

describe("runtime cache", () => {
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
