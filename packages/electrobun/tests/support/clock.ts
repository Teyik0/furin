import { jest } from "bun:test";

// Fake timers also freeze Date, performance.now(), process.hrtime() and
// Bun.nanoseconds(), so real progress is measured in event-loop turns: each
// setImmediate turn follows an I/O poll, letting file system and socket work
// complete between steps.
const TURNS_PER_STEP = 20;
const SETTLE_TURNS = 2_000_000;

/**
 * Advances bun:test's fake clock until `pending` settles, yielding several
 * real event-loop turns per 100 ms virtual step. Once `limit` virtual
 * milliseconds have elapsed, `pending` keeps getting real turns to settle:
 * work that follows a virtual deadline, such as cleanup after a timeout,
 * still needs real I/O.
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
  let turns = 0;
  while (!settled && (Date.now() - start < limit || turns < SETTLE_TURNS)) {
    // biome-ignore lint/performance/noAwaitInLoops: Each turn must observe real I/O before the clock moves.
    await new Promise((resolve) => setImmediate(resolve));
    turns += 1;
    if (Date.now() - start < limit && turns % TURNS_PER_STEP === 0) {
      jest.advanceTimersByTime(100);
    }
  }
  if (!settled) {
    throw new Error(`Still pending after ${limit} virtual milliseconds.`);
  }
  return Date.now() - start;
}
