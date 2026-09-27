export interface StartupSample {
  listenMs: number;
  readyMs: number;
}

export interface StartupAppReport extends StartupSample {
  samples: StartupSample[];
}

export interface DevStartupReport {
  apps: {
    docs: StartupAppReport;
    taskManager: StartupAppReport;
    weather: StartupAppReport;
  };
  schemaVersion: 1;
}

interface StartupBudgetRow {
  allowedMs: number;
  app: string;
  baseMs: number;
  headMs: number;
  metric: keyof StartupSample;
  status: "fail" | "pass";
}

interface StartupComparison {
  regressions: StartupBudgetRow[];
  rows: StartupBudgetRow[];
}

const APPS = [
  { key: "weather", label: "Weather" },
  { key: "taskManager", label: "Task Manager" },
  { key: "docs", label: "Documentation" },
] as const;
const METRICS = ["listenMs", "readyMs"] as const;

export function compareDevStartup(
  base: DevStartupReport,
  head: DevStartupReport
): StartupComparison {
  const rows = APPS.flatMap(({ key, label }) =>
    METRICS.map((metric): StartupBudgetRow => {
      const baseMs = base.apps[key][metric];
      const headMs = head.apps[key][metric];
      const allowedMs = Math.max(500, Math.ceil(baseMs * 0.3));
      return {
        allowedMs,
        app: label,
        baseMs,
        headMs,
        metric,
        status: headMs - baseMs > allowedMs ? "fail" : "pass",
      };
    })
  );
  return { regressions: rows.filter((row) => row.status === "fail"), rows };
}

export function formatDevStartupComparison(comparison: StartupComparison): string {
  return [
    "## Development cold-start budgets",
    "",
    "Median of three new Bun processes per app. The first response reads `/_furin/devtools/snapshot` completely. Base and PR run on the same CI runner with filesystem caches retained. The allowance is the larger of 500 ms or 30% of the base.",
    "",
    "| App | Milestone | Base | PR | Allowed regression | Result |",
    "|---|---|---:|---:|---:|:---:|",
    ...comparison.rows.map(
      (row) =>
        `| ${row.app} | ${row.metric === "listenMs" ? "Port open" : "First response"} | ${row.baseMs.toFixed(0)} ms | ${row.headMs.toFixed(0)} ms | ${row.allowedMs.toFixed(0)} ms | ${row.status === "pass" ? "✅" : "❌"} |`
    ),
    "",
    comparison.regressions.length === 0
      ? "All development cold-start budgets passed."
      : `${comparison.regressions.length} development cold-start budget(s) regressed.`,
    "",
  ].join("\n");
}

function isSample(value: unknown): value is StartupSample {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const sample = value as { listenMs?: unknown; readyMs?: unknown };
  return (
    typeof sample.listenMs === "number" &&
    Number.isFinite(sample.listenMs) &&
    sample.listenMs > 0 &&
    typeof sample.readyMs === "number" &&
    Number.isFinite(sample.readyMs) &&
    sample.readyMs >= sample.listenMs
  );
}

function isAppReport(value: unknown): value is StartupAppReport {
  if (!isSample(value)) {
    return false;
  }
  const app = value as StartupAppReport;
  return Array.isArray(app.samples) && app.samples.length > 0 && app.samples.every(isSample);
}

function isDevStartupReport(value: unknown): value is DevStartupReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const report = value as {
    apps?: { docs?: unknown; taskManager?: unknown; weather?: unknown };
    schemaVersion?: unknown;
  };
  return (
    report.schemaVersion === 1 &&
    report.apps !== undefined &&
    isAppReport(report.apps.weather) &&
    isAppReport(report.apps.taskManager) &&
    isAppReport(report.apps.docs)
  );
}

async function readReport(path: string): Promise<DevStartupReport> {
  const value: unknown = await Bun.file(path).json();
  if (!isDevStartupReport(value)) {
    throw new Error(`Invalid development startup report: ${path}`);
  }
  return value;
}

if (import.meta.main) {
  const [, , basePath, headPath, markdownPath] = Bun.argv;
  if (basePath === undefined || headPath === undefined || markdownPath === undefined) {
    throw new Error(
      "Usage: bun scripts/compare-dev-startup.ts <base.json> <head.json> <summary.md>"
    );
  }
  const comparison = compareDevStartup(await readReport(basePath), await readReport(headPath));
  const markdown = formatDevStartupComparison(comparison);
  console.log(markdown);
  await Bun.write(markdownPath, markdown);
  if (comparison.regressions.length > 0) {
    process.exitCode = 1;
  }
}
