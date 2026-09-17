import { describe, expect, test } from "bun:test";
import { serializeLoaderDataNdjson } from "../../../src/server/render/ssr.ts";
import { serializeCompactJsonLine } from "../../../src/shared/compact-json.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";

describe("loader data transport", () => {
  test("rejects accessors without evaluating them in objects or arrays", async () => {
    let calls = 0;
    const object = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        calls += 1;
        return calls;
      },
    });
    const array = Object.defineProperty([0], "0", {
      enumerable: true,
      get() {
        calls += 1;
        return calls;
      },
    });
    expect(serializeCompactJsonLine({ object })).toBeUndefined();
    expect(serializeCompactJsonLine({ array })).toBeUndefined();
    expect(calls).toBe(0);
    await Promise.resolve();
  });

  test("round-trips ordinary JSON without CrossJSON overhead", async () => {
    const data = {
      items: Array.from({ length: 40 }, (_, id) => ({
        id,
        label: `Item ${id}`,
        score: (id * 17) % 101,
      })),
      title: "Benchmark",
    };

    const payload = await serializeLoaderDataNdjson(data, {});
    const { body } = new Response(payload);
    if (body === null) {
      throw new Error("Loader payload did not produce a response body");
    }
    const result = await parseDeferredNdjson(body, undefined);

    expect(result.syncData).toEqual(data);
    expect(serializeCompactJsonLine(data)).toBe(payload);
  });

  test("preserves rich values and shared references through CrossJSON", async () => {
    const shared = { label: "shared" };
    const data = {
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      first: shared,
      missing: undefined,
      nan: Number.NaN,
      negativeZero: -0,
      second: shared,
    };

    const payload = await serializeLoaderDataNdjson(data, undefined);
    const { body } = new Response(payload);
    if (body === null) {
      throw new Error("Loader payload did not produce a response body");
    }
    const { syncData } = await parseDeferredNdjson(body, undefined);

    expect(syncData.createdAt).toBeInstanceOf(Date);
    expect(syncData.first).toBe(syncData.second);
    expect(Object.hasOwn(syncData, "missing")).toBe(true);
    expect(Number.isNaN(syncData.nan)).toBe(true);
    expect(Object.is(syncData.negativeZero, -0)).toBe(true);
  });

  test("does not confuse rich user data with the compact envelope", async () => {
    const data = {
      __furinJson: 1,
      data: {
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      },
    };

    const payload = await serializeLoaderDataNdjson(data, undefined);
    const { body } = new Response(payload);
    if (body === null) {
      throw new Error("Loader payload did not produce a response body");
    }
    const { syncData } = await parseDeferredNdjson(body, undefined);

    expect(syncData).toEqual(data);
    expect((syncData.data as { createdAt: unknown }).createdAt).toBeInstanceOf(Date);
  });

  test("rejects arrays with properties outside the JSON data model", async () => {
    const items = [1, 2] as number[] & { label?: string };
    items.label = "named property";

    expect(serializeCompactJsonLine({ items })).toBeUndefined();
    await Promise.resolve();
  });
});
