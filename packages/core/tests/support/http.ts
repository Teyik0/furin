// biome-ignore-all lint/performance/noAwaitInLoops: HTTP readiness helper must wait between fetch attempts
let _testPortCounter = 10_000 + (process.pid % 18_000);

export async function waitForHttp(
  url: string,
  options: {
    intervalMs?: number;
    timeoutMs?: number;
  }
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const intervalMs = options.intervalMs ?? 100;
  const startedAt = Date.now();

  for (;;) {
    const remaining = timeoutMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for ${url}`);
    }

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (response.ok) {
          return response;
        }
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Retry until timeout.
    }

    await Bun.sleep(intervalMs);
  }
}

export function getTestPort(): number {
  _testPortCounter += 1;
  return _testPortCounter;
}
