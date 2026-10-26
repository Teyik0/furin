import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cancelPendingStartup } from "../src/cli";

test.each([true, false])(
  "startup hard cancellation respects published readiness=%s",
  async (ready) => {
    const root = await mkdtemp(join(tmpdir(), "furin-cancel-readiness-"));
    const file = join(root, "ready.json");
    const responsive = Promise.withResolvers<void>();
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        'process.on("message", () => process.send("alive")); setInterval(() => {}, 1000);',
      ],
      {
        stdout: "ignore",
        stderr: "ignore",
        ipc: () => responsive.resolve(),
        timeout: 2000,
        killSignal: "SIGKILL",
      }
    );
    try {
      if (ready) {
        await writeFile(file, "{}");
      }
      cancelPendingStartup(child, file);
      if (ready) {
        child.send("probe");
        expect(
          await Promise.race([responsive.promise.then(() => true), child.exited.then(() => false)])
        ).toBe(true);
      } else {
        expect(await child.exited).not.toBe(137);
      }
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
      await rm(root, { recursive: true, force: true });
    }
  }
);
