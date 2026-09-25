import { expect, test } from "bun:test";

type RscScenarioResult =
  | { message: string; stack: string | undefined; type: "fail" }
  | { type: "pass" };

function runRscScenarioWorker(): Promise<RscScenarioResult> {
  const worker = new Worker(new URL("./rsc.scenario.tsx", import.meta.url), { type: "module" });

  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<RscScenarioResult>) => {
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
  "RSC public API scenarios",
  async () => {
    const result = await runRscScenarioWorker();
    if (result.type === "fail") {
      throw new Error([result.message, result.stack].filter(Boolean).join("\n"));
    }
    expect(result.type).toBe("pass");
  },
  { timeout: 30_000 }
);
