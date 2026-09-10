import { expect, test } from "bun:test";
import {
  type DevtoolsPendingCycle,
  takeDevtoolsPendingCycle,
} from "../../../src/server/devtools/build-observer.ts";

test("each instance projects a shared client build onto its own watcher cycle", () => {
  const sourcePath = `/tmp/shared-${crypto.randomUUID()}.tsx`;
  const frontCycles: DevtoolsPendingCycle[] = [
    { cycleId: "front-cycle", detectedAt: 1000, sourcePath },
  ];
  const adminCycles: DevtoolsPendingCycle[] = [
    { cycleId: "admin-cycle", detectedAt: 1000, sourcePath },
  ];

  expect(takeDevtoolsPendingCycle(frontCycles, [sourcePath])?.cycleId).toBe("front-cycle");
  expect(takeDevtoolsPendingCycle(adminCycles, [sourcePath])?.cycleId).toBe("admin-cycle");
  expect(frontCycles).toEqual([]);
  expect(adminCycles).toEqual([]);
});
