import { expect, test } from "bun:test";

type DevCacheScenarioResult =
  | { message: string; stack: string | undefined; type: "fail" }
  | { type: "pass" };

function runDevCacheScenarioWorker(): Promise<DevCacheScenarioResult> {
  const worker = new Worker(new URL("./dev-isr-loader-cache.scenario.ts", import.meta.url), {
    type: "module",
  });

  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<DevCacheScenarioResult>) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
  });
}

test(
  "dev ISR and SSG loader cache integration",
  async () => {
    const result = await runDevCacheScenarioWorker();
    if (result.type === "fail") {
      throw new Error([result.message, result.stack].filter(Boolean).join("\n"));
    }
    expect(result.type).toBe("pass");
  },
  { timeout: 30_000 }
);
