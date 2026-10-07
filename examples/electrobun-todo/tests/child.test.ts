import { expect, test } from "bun:test";
import { waitForChild } from "./child";

test("kills and reaps an owned Bun child that exceeds its deadline", async () => {
  const child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  try {
    await expect(waitForChild(child, 100)).rejects.toThrow("Child exceeded 100ms deadline");
    if (process.platform !== "win32") {
      expect(child.signalCode).toBe("SIGKILL");
    }
    expect(() => process.kill(child.pid, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await child.exited;
  }
}, 5000);

test("preserves normal and nonzero child exit codes and clears their deadlines", async () => {
  for (const exitCode of [0, 7]) {
    const child = Bun.spawn([process.execPath, "-e", `process.exit(${exitCode})`], {
      stdout: "ignore",
      stderr: "ignore",
    });
    // biome-ignore lint/performance/noAwaitInLoops: verify each real child is reaped
    expect(await waitForChild(child, 1000)).toBe(exitCode);
    expect(child.signalCode).toBeNull();
  }
  // A leaked deadline would attempt to kill these already-reaped children.
  await Bun.sleep(1100);
}, 5000);
