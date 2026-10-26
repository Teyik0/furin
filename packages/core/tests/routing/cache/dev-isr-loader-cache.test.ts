import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

type DevCacheScenarioResult =
  | { message: string; stack: string | undefined; type: "fail" }
  | { type: "pass" };

async function runDevCacheScenario(): Promise<DevCacheScenarioResult> {
  let result: DevCacheScenarioResult | undefined;
  const disconnected = Promise.withResolvers<void>();
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./dev-isr-loader-cache.scenario.ts", import.meta.url)),
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      ipc(message: DevCacheScenarioResult) {
        result = message;
      },
      onDisconnect: () => disconnected.resolve(),
      timeout: 25_000,
      killSignal: "SIGKILL",
    }
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    disconnected.promise,
  ]);
  if (!result || (result.type === "pass" && code !== 0)) {
    throw new Error(`Dev cache scenario exited (${code}): ${stderr}\n${stdout}`);
  }
  return result;
}

test(
  "dev ISR and SSG loader cache integration",
  async () => {
    const cwd = process.cwd();
    const result = await runDevCacheScenario();
    expect(process.cwd()).toBe(cwd);
    if (result.type === "fail") {
      throw new Error([result.message, result.stack].filter(Boolean).join("\n"));
    }
    expect(result.type).toBe("pass");
  },
  { timeout: 30_000 }
);
