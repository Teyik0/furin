// biome-ignore-all lint/performance/noAwaitInLoops: test stream fixtures intentionally consume chunks in order
import { describe, expect, test } from "bun:test";
import { toCrossJSON, toCrossJSONAsync } from "seroval";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";

// ── parseDeferredNdjson tests ────────────────────────────────────────────────
//
// parseDeferredNdjson(stream: ReadableStream<Uint8Array>):
//   Promise<{ syncData: RuntimeData; deferredPromises: Record<string, Promise<unknown>> }>
//
// Behaviour:
// - Line 0: CrossJSON skeleton — contains syncData + placeholders for Promises
// - Subsequent lines: deferred Promise resolutions (CrossJSON)
//
// We simulate the format emitted by toCrossJSONStream({ syncField: "x", stats: Promise.resolve(42) })

function makeNdjsonStream(lines: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(enc.encode(`${line}\n`));
      }
      controller.close();
    },
  });
}

describe("parseDeferredNdjson()", () => {
  test("parses an NDJSON stream with only synchronous data", async () => {
    // Simulates toCrossJSONStream({ title: "hello" }) → 1 line (no Promises)
    const syncValue = { count: 42, title: "hello" };
    const crossJson = toCrossJSON(syncValue);
    const stream = makeNdjsonStream([JSON.stringify(crossJson)]);

    const result = await parseDeferredNdjson(stream, undefined);

    expect(result.syncData).toEqual({ count: 42, title: "hello" });
    expect(Object.keys(result.deferredPromises)).toHaveLength(0);
  });

  test("parses an NDJSON stream with a deferred Promise", async () => {
    // Simulates toCrossJSONStream({ title: "board", stats: Promise.resolve(99) })
    const statsPromise = Promise.resolve(99);
    const ndjsonLines: string[] = [];
    const stream = toCrossJSONStream({ stats: statsPromise, title: "board" });
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      ndjsonLines.push(value);
    }

    const ndjsonStream = makeNdjsonStream(ndjsonLines);
    const result = await parseDeferredNdjson(ndjsonStream, undefined);

    // syncData contains the scalars
    expect(result.syncData.title).toBe("board");
    // deferredPromises contains a Promise for "stats"
    expect(result.deferredPromises.stats).toBeInstanceOf(Promise);
    const resolvedStats = await result.deferredPromises.stats;
    expect(resolvedStats).toBe(99);
  });

  test("returns on the initial line and resolves Promises with subsequent lines", async () => {
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });

    const parsePromise = parseDeferredNdjson(stream, undefined);
    controller.enqueue(
      enc.encode(
        `${JSON.stringify(toCrossJSON({ __furinDeferredKeys: ["data"], title: "hello" }))}\n`
      )
    );

    const result = await parsePromise;
    expect(result.syncData).toEqual({ title: "hello" });
    const dataPromise = result.deferredPromises.data as Promise<unknown>;
    expect(dataPromise).toBeInstanceOf(Promise);

    let settled = false;
    dataPromise.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    controller.enqueue(
      enc.encode(
        `${JSON.stringify({ action: "resolve", key: "data", value: toCrossJSON("slow") })}\n`
      )
    );
    controller.close();

    expect(await dataPromise).toBe("slow");
  });
});

// Helper — wraps toCrossJSONAsync into a single-line NDJSON ReadableStream
function toCrossJSONStream(value: unknown): ReadableStream<string> {
  return new ReadableStream<string>({
    async start(controller) {
      try {
        const result = await toCrossJSONAsync(value);
        controller.enqueue(JSON.stringify(result));
        controller.close();
      } catch (e) {
        controller.error(e);
      }
    },
  });
}
