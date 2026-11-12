import { jest } from "bun:test";

/**
 * Advances bun:test's fake clock until `pending` settles, yielding one real
 * event-loop turn per step so file system and socket work keep progressing.
 * Resolves with the virtual milliseconds that elapsed.
 */
export async function settleOnFakeClock(pending: Promise<unknown>, limit: number): Promise<number> {
  let settled = false;
  pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  const start = Date.now();
  while (!settled && Date.now() - start < limit) {
    // biome-ignore lint/performance/noAwaitInLoops: Each step must observe real I/O before the clock moves.
    await new Promise((resolve) => setImmediate(resolve));
    jest.advanceTimersByTime(100);
  }
  if (!settled) {
    throw new Error(`Still pending after ${limit} virtual milliseconds.`);
  }
  return Date.now() - start;
}
