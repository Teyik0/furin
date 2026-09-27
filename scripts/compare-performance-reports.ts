export interface PerformanceMetrics {
  initialCssGzipBytes: number;
  initialJavaScriptGzipBytes: number;
  largestLazyChunkGzipBytes: number;
  serverBinaryBytes: number;
  totalClientGzipBytes: number;
}

export interface PerformanceReport {
  metrics: PerformanceMetrics;
  schemaVersion: 1;
}

type PerformanceMetricName = keyof PerformanceMetrics;

interface PerformanceBudget {
  absoluteBytes: number;
  label: string;
  metric: PerformanceMetricName;
  relativeRatio: number;
}

export interface PerformanceComparisonRow {
  allowedDeltaBytes: number;
  baseBytes: number;
  deltaBytes: number;
  headBytes: number;
  label: string;
  status: "fail" | "pass";
}

export interface PerformanceComparison {
  reactMigration: boolean;
  regressions: PerformanceComparisonRow[];
  rows: PerformanceComparisonRow[];
}

const KIBIBYTE = 1024;
const MEBIBYTE = 1024 * KIBIBYTE;
const REACT_19_3_GZIP_ALLOWANCE = 8 * KIBIBYTE;
const PERFORMANCE_BUDGETS: PerformanceBudget[] = [
  {
    absoluteBytes: KIBIBYTE,
    label: "Initial JavaScript gzip",
    metric: "initialJavaScriptGzipBytes",
    relativeRatio: 0.02,
  },
  {
    absoluteBytes: KIBIBYTE,
    label: "Initial CSS gzip",
    metric: "initialCssGzipBytes",
    relativeRatio: 0.02,
  },
  {
    absoluteBytes: 2 * KIBIBYTE,
    label: "Total client gzip",
    metric: "totalClientGzipBytes",
    relativeRatio: 0.02,
  },
  {
    absoluteBytes: 2 * KIBIBYTE,
    label: "Largest lazy chunk gzip",
    metric: "largestLazyChunkGzipBytes",
    relativeRatio: 0.05,
  },
  {
    absoluteBytes: MEBIBYTE,
    label: "Embedded server binary",
    metric: "serverBinaryBytes",
    relativeRatio: 0.02,
  },
];

interface UnknownPerformanceMetrics {
  initialCssGzipBytes?: unknown;
  initialJavaScriptGzipBytes?: unknown;
  largestLazyChunkGzipBytes?: unknown;
  serverBinaryBytes?: unknown;
  totalClientGzipBytes?: unknown;
}

interface UnknownPerformanceReport {
  metrics?: UnknownPerformanceMetrics;
  schemaVersion?: unknown;
}

function isPerformanceReport(value: unknown): value is PerformanceReport {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as UnknownPerformanceReport;
  const { metrics } = candidate;
  return (
    candidate.schemaVersion === 1 &&
    typeof metrics === "object" &&
    metrics !== null &&
    typeof metrics.initialCssGzipBytes === "number" &&
    typeof metrics.initialJavaScriptGzipBytes === "number" &&
    typeof metrics.largestLazyChunkGzipBytes === "number" &&
    typeof metrics.serverBinaryBytes === "number" &&
    typeof metrics.totalClientGzipBytes === "number"
  );
}

export function comparePerformanceReports(
  base: PerformanceReport,
  head: PerformanceReport,
  baseReactVersion: string,
  headReactVersion: string
): PerformanceComparison {
  const reactMigration =
    baseReactVersion.startsWith("19.2.") && headReactVersion.startsWith("19.3.");
  const rows = PERFORMANCE_BUDGETS.map((budget): PerformanceComparisonRow => {
    const baseBytes = base.metrics[budget.metric];
    const headBytes = head.metrics[budget.metric];
    const deltaBytes = headBytes - baseBytes;
    const allowedDeltaBytes =
      Math.max(budget.absoluteBytes, Math.ceil(baseBytes * budget.relativeRatio)) +
      (reactMigration &&
      (budget.metric === "initialJavaScriptGzipBytes" || budget.metric === "totalClientGzipBytes")
        ? REACT_19_3_GZIP_ALLOWANCE
        : 0);
    return {
      allowedDeltaBytes,
      baseBytes,
      deltaBytes,
      headBytes,
      label: budget.label,
      status: deltaBytes > allowedDeltaBytes ? "fail" : "pass",
    };
  });
  return {
    reactMigration,
    regressions: rows.filter((row) => row.status === "fail"),
    rows,
  };
}

function formatBytes(bytes: number): string {
  const absoluteBytes = Math.abs(bytes);
  if (absoluteBytes >= MEBIBYTE) {
    return `${(bytes / MEBIBYTE).toFixed(2)} MiB`;
  }
  return `${(bytes / KIBIBYTE).toFixed(2)} KiB`;
}

function formatDelta(bytes: number): string {
  return `${bytes > 0 ? "+" : ""}${formatBytes(bytes)}`;
}

export function formatPerformanceComparison(comparison: PerformanceComparison): string {
  const lines = [
    "<!-- furin-performance-report -->",
    "## Furin performance budgets",
    "",
    "| Metric | Base | PR | Delta | Allowed regression | Result |",
    "|---|---:|---:|---:|---:|:---:|",
    ...comparison.rows.map(
      (row) =>
        `| ${row.label} | ${formatBytes(row.baseBytes)} | ${formatBytes(row.headBytes)} | ${formatDelta(row.deltaBytes)} | ${formatBytes(row.allowedDeltaBytes)} | ${row.status === "pass" ? "✅" : "❌"} |`
    ),
    "",
    comparison.regressions.length === 0
      ? "All deterministic performance budgets passed."
      : `${comparison.regressions.length} performance budget(s) regressed beyond the allowed threshold.`,
    ...(comparison.reactMigration
      ? [
          "",
          `The React 19.2 → 19.3 upgrade adds a one-time ${formatBytes(REACT_19_3_GZIP_ALLOWANCE)} allowance to initial and total JavaScript gzip. Later changes use the normal budgets.`,
        ]
      : []),
    "",
  ];
  return lines.join("\n");
}

async function readReport(path: string): Promise<PerformanceReport> {
  const value: unknown = await Bun.file(path).json();
  if (!isPerformanceReport(value)) {
    throw new Error(`Invalid performance report: ${path}`);
  }
  return value;
}

async function main(): Promise<void> {
  const [, , basePath, headPath, markdownPath, baseReactVersion, headReactVersion] = Bun.argv;
  if (
    basePath === undefined ||
    headPath === undefined ||
    baseReactVersion === undefined ||
    headReactVersion === undefined
  ) {
    console.error(
      "Usage: bun scripts/compare-performance-reports.ts <base.json> <head.json> <summary.md> <base-react> <head-react>"
    );
    process.exit(1);
  }
  const comparison = comparePerformanceReports(
    await readReport(basePath),
    await readReport(headPath),
    baseReactVersion,
    headReactVersion
  );
  const markdown = formatPerformanceComparison(comparison);
  console.log(markdown);
  if (markdownPath !== undefined) {
    await Bun.write(markdownPath, markdown);
  }
  if (comparison.regressions.length > 0) {
    process.exit(1);
  }
}

if (import.meta.main) {
  await main();
}
