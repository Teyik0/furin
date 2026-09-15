import { describe, expect, test } from "bun:test";
import { toCrossJSONAsync } from "seroval";
import { serializeLoaderDataNdjson } from "../../../src/server/render/ssr.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";

describe("loader data transport", () => {
  test("round-trips ordinary JSON without CrossJSON overhead", async () => {
    const data = {
      items: Array.from({ length: 40 }, (_, id) => ({
        id,
        label: `Item ${id}`,
        score: (id * 17) % 101,
      })),
      title: "Benchmark",
    };
    const crossJson = `${JSON.stringify(await toCrossJSONAsync(data))}\n`;

    const payload = await serializeLoaderDataNdjson(data, {});
    const { body } = new Response(payload);
    if (body === null) {
      throw new Error("Loader payload did not produce a response body");
    }
    const result = await parseDeferredNdjson(body, undefined);

    expect(result.syncData).toEqual(data);
    expect(payload.length).toBeLessThan(crossJson.length / 2);
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
});
