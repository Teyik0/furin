import { expect, test } from "bun:test";
import { withBuildTestLock } from "../../support/build-lock.ts";

test("isolated DevTools browser entries build without the application graph", () =>
  withBuildTestLock(async () => {
    const entries = ["collector.ts", "dashboard.tsx"];
    for (const entry of entries) {
      // biome-ignore lint/performance/noAwaitInLoops: Bun 1.4 deadlocks concurrent Bun.build calls
      const result = await Bun.build({
        entrypoints: [`${import.meta.dir}/../../../src/devtools/${entry}`],
        format: "esm",
        minify: true,
        target: "browser",
      });
      expect(result.success).toBe(true);
      expect(result.outputs.some((output) => output.path.endsWith(".js"))).toBe(true);
    }
  }));
