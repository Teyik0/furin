import { describe, expect, test } from "bun:test";
import { toCrossJSON } from "seroval";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { serializeRouteFrames } from "../../../src/shared/route-frame.ts";

const enc = new TextEncoder();

function ndjsonLine(obj: unknown): Uint8Array {
  return enc.encode(`${JSON.stringify(obj)}\n`);
}

interface ControlledStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
  stream: ReadableStream<Uint8Array>;
}

function makeControlledStream(initialBytes: Uint8Array): ControlledStream {
  let captured: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      captured = c;
      c.enqueue(initialBytes);
    },
  });
  if (!captured) {
    throw new Error("controller not captured");
  }
  return { controller: captured, stream };
}

describe("parseDeferredNdjson — error paths", () => {
  test("malformed first NDJSON line → rejects with an explicit error", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode("{not valid json}\n"));
        c.close();
      },
    });

    await expect(parseDeferredNdjson(stream, undefined)).rejects.toThrow();
  });

  test("malformed NDJSON resolution line → the corresponding promise rejects, others do not leak", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["a"], title: "x" }));
    const { stream, controller } = makeControlledStream(initial);

    const result = await parseDeferredNdjson(stream, undefined);
    const pA = result.deferredPromises.a as Promise<unknown>;

    controller.enqueue(enc.encode("not-valid-json\n"));
    controller.close();

    const err = await pA.then(() => null).catch((e: unknown) => e);
    expect(err).toBeDefined();
    expect(err).toBeInstanceOf(SyntaxError);
  });

  test("stream cut mid-way (done before all chunks) → remaining resolvers reject", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["a", "b"], title: "x" }));
    const { stream, controller } = makeControlledStream(initial);

    const result = await parseDeferredNdjson(stream, undefined);
    const pA = result.deferredPromises.a as Promise<unknown>;
    const pB = result.deferredPromises.b as Promise<unknown>;

    // Resolve "a", then close the stream without "b".
    controller.enqueue(ndjsonLine({ action: "resolve", key: "a", value: toCrossJSON(1) }));
    controller.close();

    expect(await pA).toBe(1);

    // "b" never arrives. With the current implementation, the resolver is
    // dropped by readDeferredLines (it returns on empty line) without an
    // error — so the promise stays pending forever. Surface this as a
    // dedicated rejection so consumers don't hang.
    const errB = await Promise.race([
      pB.then(() => "resolved" as const).catch((e: unknown) => e),
      new Promise<"pending">((r) => setTimeout(() => r("pending"), 50)),
    ]);
    expect(errB).not.toBe("pending");
    expect(errB).not.toBe("resolved");
  });
});

describe("parseDeferredNdjson — AbortSignal", () => {
  test("canceling a fetched route-frame stream preserves deferred rejection without an unhandled error", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(enc.encode(serializeRouteFrames({ title: "ready" }, ["pending"])));
            },
          })
        ),
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);
    try {
      const abort = new AbortController();
      const response = await fetch(server.url, { signal: abort.signal });
      if (!response.body) {
        throw new Error("Missing route-frame stream");
      }
      const result = await parseDeferredNdjson(response.body, abort.signal);
      expect(result.syncData.title).toBe("ready");
      abort.abort();
      await expect(result.deferredPromises.pending).rejects.toHaveProperty("name", "AbortError");
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await server.stop(true);
    }
  });

  test("abandoned deferred promises do not leak an unhandled AbortError", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["abandoned"], title: "x" }));
    const { stream } = makeControlledStream(initial);
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => unhandled.push(error);
    process.on("unhandledRejection", onUnhandled);

    try {
      const abort = new AbortController();
      await parseDeferredNdjson(stream, abort.signal);
      abort.abort();
      await Bun.sleep(20);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("signal that aborts while waiting → pending promises reject with AbortError", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["a", "b"], title: "x" }));
    const { stream } = makeControlledStream(initial);

    const abort = new AbortController();
    const result = await parseDeferredNdjson(stream, abort.signal);

    const pA = result.deferredPromises.a as Promise<unknown>;
    const pB = result.deferredPromises.b as Promise<unknown>;
    expect(pA).toBeInstanceOf(Promise);
    expect(pB).toBeInstanceOf(Promise);

    abort.abort();

    const errA = await pA.then(() => null).catch((e: unknown) => e);
    const errB = await pB.then(() => null).catch((e: unknown) => e);

    expect(errA).toBeDefined();
    expect(errB).toBeDefined();
    expect((errA as { name?: string }).name).toBe("AbortError");
    expect((errB as { name?: string }).name).toBe("AbortError");
  });

  test("signal already aborted before the call → cancels before reading bytes", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["a"], title: "x" }));
    const { stream } = makeControlledStream(initial);

    const abort = new AbortController();
    abort.abort();

    const result = await parseDeferredNdjson(stream, abort.signal);
    expect(result.syncData).toEqual({});
    expect(result.deferredPromises).toEqual({});
  });

  test("signal already aborted before first bytes arrive → does not hang on reader.read()", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const abort = new AbortController();
    abort.abort();

    const result = await Promise.race([
      parseDeferredNdjson(stream, abort.signal),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);

    expect(result).not.toBe("pending");
    expect(result).toEqual({ deferredPromises: {}, syncData: {} });
  });

  test("undefined signal → works as before, promises resolved by chunks", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["a"], title: "x" }));
    const { stream, controller } = makeControlledStream(initial);

    const result = await parseDeferredNdjson(stream, undefined);
    const pA = result.deferredPromises.a as Promise<unknown>;

    controller.enqueue(ndjsonLine({ action: "resolve", key: "a", value: toCrossJSON(42) }));
    controller.close();

    expect(await pA).toBe(42);
  });

  test("chunks that arrived before abort are preserved, only pending ones reject", async () => {
    const initial = ndjsonLine(toCrossJSON({ __furinDeferredKeys: ["a", "b"], title: "x" }));
    const { stream, controller } = makeControlledStream(initial);

    const abort = new AbortController();
    const result = await parseDeferredNdjson(stream, abort.signal);
    const pA = result.deferredPromises.a as Promise<unknown>;
    const pB = result.deferredPromises.b as Promise<unknown>;

    // Resolve "a" before abort.
    controller.enqueue(ndjsonLine({ action: "resolve", key: "a", value: toCrossJSON("done") }));

    // Give the parser a microtask to consume "a".
    await new Promise((r) => setTimeout(r, 5));

    abort.abort();

    expect(await pA).toBe("done");
    const errB = await pB.then(() => null).catch((e: unknown) => e);
    expect((errB as { name?: string }).name).toBe("AbortError");
  });
});
