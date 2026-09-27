import { expect, test } from "bun:test";
import {
  compareDevStartup,
  formatDevStartupComparison,
  type DevStartupReport,
} from "../../../../../scripts/compare-dev-startup.ts";

function report(listenMs: number, readyMs: number): DevStartupReport {
  const app = { listenMs, readyMs, samples: [{ listenMs, readyMs }] };
  return {
    apps: { docs: app, taskManager: app, weather: app },
    schemaVersion: 1,
  };
}

test("the startup budget compares every app's port and first response", () => {
  const comparison = compareDevStartup(report(1000, 1500), report(1600, 2100));

  expect(comparison.rows).toHaveLength(6);
  expect(comparison.regressions).toHaveLength(6);
  expect(comparison.rows[0]).toMatchObject({
    allowedMs: 500,
    app: "Weather",
    metric: "listenMs",
    status: "fail",
  });
  expect(formatDevStartupComparison(comparison)).toContain("Weather");
  expect(formatDevStartupComparison(comparison)).toContain("Documentation");
});

test("the startup budget accepts normal runner variance using the larger absolute or relative allowance", () => {
  const base = report(1000, 4000);
  const head = report(1499, 5100);

  const comparison = compareDevStartup(base, head);

  expect(comparison.regressions).toEqual([]);
  expect(comparison.rows.find((row) => row.metric === "readyMs")?.allowedMs).toBe(1200);
});
