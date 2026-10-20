import { afterAll } from "bun:test";
import { allInstances, defaultInstanceBucket } from "../../src/server/instance.ts";
import { IS_DEV } from "../../src/server/runtime-env.ts";

// Process-level Furin state a test file changes must be restored by that file,
// or every later file sharing the process (`bun test` without `--isolate`)
// inherits it. Preload hooks run after each file under `--isolate` and
// `--parallel --no-isolate`, and once at the end of a plain `bun test`.
const defaultDevelopment = IS_DEV;

afterAll(() => {
  const leaks: string[] = [];
  if (IS_DEV !== defaultDevelopment) {
    leaks.push(`the default runtime mode is still development=${IS_DEV} (restore __setDevMode)`);
  }
  const runtimes = allInstances().filter((runtime) => runtime !== defaultInstanceBucket());
  if (runtimes.length > 0) {
    const mounts = runtimes.map((runtime) => `${runtime.prefix || "/"} (${runtime.pagesDir})`);
    leaks.push(`runtimes are still registered: ${mounts.join(", ")} (__clearInstanceRegistry)`);
  }
  if (leaks.length > 0) {
    throw new Error(`[test] ${Bun.main} leaked process state:\n- ${leaks.join("\n- ")}`);
  }
});
