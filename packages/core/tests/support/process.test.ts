import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { runProcess } from "./process.ts";
import { expectDefined } from "./utils.ts";

const PACKAGE_ROOT = resolve(import.meta.dir, "../..");
const CHILD_PID_RE = /child-pid:(\d+)/;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() > deadline) {
      return false;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls until the child exits
    await Bun.sleep(50);
  }
  return true;
}

test("a process started by startProcess does not outlive a bailed bun test run", async () => {
  const run = await runProcess(
    [process.execPath, "test", "./tests/support/process-bail.fixture.ts", "--bail"],
    { cwd: PACKAGE_ROOT, timeoutMs: 30_000 }
  );
  const match = CHILD_PID_RE.exec(run.stdout + run.stderr);
  expectDefined(match);
  const pid = Number(match[1]);

  const exited = await waitForExit(pid, 2000);
  if (!exited) {
    process.kill(pid);
  }

  expect(run.exitCode).toBe(1);
  expect(exited).toBe(true);
});
