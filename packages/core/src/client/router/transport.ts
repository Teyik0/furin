/** A live stream can be cached only while its pending values still have an owner. */
export function trackDeferredTransport(
  promises: { [key: string]: Promise<unknown> },
  signal: AbortSignal | undefined
): () => boolean {
  const pending = Object.values(promises);
  if (pending.length === 0 || signal === undefined) {
    return () => true;
  }
  let settled = false;
  let cancelled = signal.aborted;
  const abort = () => {
    if (!settled) {
      cancelled = true;
    }
  };
  signal.addEventListener("abort", abort, { once: true });
  Promise.allSettled(pending).then(() => {
    settled = true;
    signal.removeEventListener("abort", abort);
  });
  return () => !cancelled;
}
