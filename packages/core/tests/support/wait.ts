/** Polls `predicate` every 10ms until it holds, failing with `message` after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(message);
    }
    // biome-ignore lint/performance/noAwaitInLoops: bounded polling waits for an observable state.
    await Bun.sleep(10);
  }
}
