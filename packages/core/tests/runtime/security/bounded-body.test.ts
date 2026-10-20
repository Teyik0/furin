import { describe, expect, test } from "bun:test";
import { readBoundedBytes } from "../../../src/server/bounded-body.ts";

function chunkedStream(chunks: string[], onCancel: () => void): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    cancel: onCancel,
    pull(controller) {
      const chunk = chunks[index];
      index += 1;
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

describe("readBoundedBytes", () => {
  test("concatenates every chunk when the body fits the limit", async () => {
    const bytes = await readBoundedBytes(
      chunkedStream(["ab", "cd", "e"], () => undefined),
      5
    );

    expect(new TextDecoder().decode(bytes)).toBe("abcde");
  });

  test("returns undefined and cancels the stream once the limit is exceeded", async () => {
    let cancelled = false;
    const stream = chunkedStream(["abc", "def", "ghi"], () => {
      cancelled = true;
    });

    expect(await readBoundedBytes(stream, 5)).toBeUndefined();
    expect(cancelled).toBe(true);
  });

  test("still reports an oversized body when cancelling the stream fails", async () => {
    const stream = chunkedStream(["abc", "def"], () => {
      throw new Error("cancel failed");
    });

    expect(await readBoundedBytes(stream, 5)).toBeUndefined();
  });

  test("releases the stream so the caller can still cancel or inspect it", async () => {
    const stream = chunkedStream(["abc"], () => undefined);

    await readBoundedBytes(stream, 5);

    expect(stream.locked).toBe(false);
  });
});
