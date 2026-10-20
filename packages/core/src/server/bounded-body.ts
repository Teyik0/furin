/**
 * Reads a whole byte stream, or returns `undefined` (after cancelling the
 * stream) as soon as it grows past `maxBytes`, so an oversized body is never
 * buffered in full.
 */
export async function readBoundedBytes(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number
): Promise<Uint8Array | undefined> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: stream chunks must be read sequentially.
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
