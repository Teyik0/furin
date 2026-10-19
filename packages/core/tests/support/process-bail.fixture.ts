// Run by process.test.ts with `bun test --bail`.
import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startProcess } from "./process.ts";

const server = startProcess(
  [process.execPath, "--hot", join(import.meta.dir, "process-idle.fixture.ts")],
  { cwd: import.meta.dir }
);
console.log(`child-pid:${server.pid}`);

// `--bail` exits before this hook runs.
afterAll(() => server.kill());

test("fails while the child is running", () => {
  expect(server.pid).toBe(-1);
});
