import { expect, test } from "bun:test";
import {
  compareDevStartup,
  formatDevStartupComparison,
  type DevStartupReport,
} from "../../../../../scripts/compare-dev-startup.ts";

function report(listenMs: number, readyMs: number, secondRouteMs: number): DevStartupReport {
  const app = { listenMs, readyMs, secondRouteMs, samples: [{ listenMs, readyMs, secondRouteMs }] };
  return {
    apps: { docs: app, taskManager: app, weather: app },
    schemaVersion: 2,
  };
}

test("the startup budget compares every app's port and both rendered pages", () => {
  const comparison = compareDevStartup(report(1000, 1500, 1000), report(1600, 2100, 1600));

  expect(comparison.rows).toHaveLength(9);
  expect(comparison.regressions).toHaveLength(9);
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
  const base = report(1000, 4000, 100);
  const head = report(1499, 5100, 110);

  const comparison = compareDevStartup(base, head);

  expect(comparison.regressions).toEqual([]);
  expect(comparison.rows.find((row) => row.metric === "readyMs")?.allowedMs).toBe(1200);
});

test("opening the port sooner cannot hide slower page rendering", () => {
  const comparison = compareDevStartup(report(1000, 1500, 100), report(200, 2500, 700));
  expect(comparison.regressions.map((row) => row.metric)).not.toContain("listenMs");
  expect(comparison.regressions).toHaveLength(6);
});
