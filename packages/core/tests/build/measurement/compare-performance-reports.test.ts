import { describe, expect, test } from "bun:test";
import {
  comparePerformanceReports,
  formatPerformanceComparison,
  type PerformanceReport,
} from "../../../../../scripts/compare-performance-reports.ts";

function report(metrics: PerformanceReport["metrics"]): PerformanceReport {
  return { metrics, schemaVersion: 1 };
}

describe("compare-performance-reports", () => {
  test("accepts changes within the agreed relative or absolute budgets", () => {
    const base = report({
      initialCssGzipBytes: 10_000,
      initialJavaScriptGzipBytes: 100_000,
      largestLazyChunkGzipBytes: 40_000,
      serverBinaryBytes: 50_000_000,
      totalClientGzipBytes: 150_000,
    });
    const head = report({
      initialCssGzipBytes: 10_900,
      initialJavaScriptGzipBytes: 101_500,
      largestLazyChunkGzipBytes: 41_500,
      serverBinaryBytes: 50_500_000,
      totalClientGzipBytes: 151_500,
    });

    const comparison = comparePerformanceReports(base, head, "19.2.8", "19.2.8", false, false);

    expect(comparison.regressions).toEqual([]);
    expect(comparison.rows.every((row) => row.status === "pass")).toBe(true);
  });

  test("rejects a metric only after both its relative and absolute allowances", () => {
    const base = report({
      initialCssGzipBytes: 10_000,
      initialJavaScriptGzipBytes: 100_000,
      largestLazyChunkGzipBytes: 40_000,
      serverBinaryBytes: 50_000_000,
      totalClientGzipBytes: 150_000,
    });
    const head = report({
      ...base.metrics,
      initialJavaScriptGzipBytes: 102_001,
    });

    const comparison = comparePerformanceReports(base, head, "19.2.8", "19.2.8", false, false);

    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]).toMatchObject({
      allowedDeltaBytes: 2000,
      deltaBytes: 2001,
      label: "Initial JavaScript gzip",
      status: "fail",
    });
  });

  test("formats a report that can identify its persistent PR comment", () => {
    const base = report({
      initialCssGzipBytes: 10_000,
      initialJavaScriptGzipBytes: 100_000,
      largestLazyChunkGzipBytes: 40_000,
      serverBinaryBytes: 50_000_000,
      totalClientGzipBytes: 150_000,
    });

    const markdown = formatPerformanceComparison(
      comparePerformanceReports(base, base, "19.2.8", "19.2.8", false, false)
    );

    expect(markdown).toStartWith("<!-- furin-performance-report -->\n");
    expect(markdown).toContain("## Furin performance budgets");
    expect(markdown).toContain("All deterministic performance budgets passed.");
  });
});

test("allows the measured React 19.3 migration cost only for that version change", () => {
  const base = report({
    initialCssGzipBytes: 10_000,
    initialJavaScriptGzipBytes: 100_000,
    largestLazyChunkGzipBytes: 40_000,
    serverBinaryBytes: 50_000_000,
    totalClientGzipBytes: 150_000,
  });
  const head = report({
    ...base.metrics,
    initialJavaScriptGzipBytes: 109_000,
    totalClientGzipBytes: 159_000,
  });

  expect(comparePerformanceReports(base, head, "19.2.8", "19.3.0", false, false).regressions).toEqual([]);
  expect(comparePerformanceReports(base, head, "19.3.0", "19.3.0", false, false).regressions).toHaveLength(
    2
  );
});

test("allows the measured docs workbench CSS only when the PR introduces it", () => {
  const base = report({
    initialCssGzipBytes: 14_000,
    initialJavaScriptGzipBytes: 117_000,
    largestLazyChunkGzipBytes: 23_000,
    serverBinaryBytes: 96_000_000,
    totalClientGzipBytes: 247_000,
  });
  const head = report({ ...base.metrics, initialCssGzipBytes: 16_000 });

  expect(
    comparePerformanceReports(base, head, "19.3.1", "19.3.1", false, true).regressions
  ).toEqual([]);
  expect(
    comparePerformanceReports(base, head, "19.3.1", "19.3.1", true, true).regressions.map(
      (row) => row.label
    )
  ).toEqual(["Initial CSS gzip"]);
  expect(
    formatPerformanceComparison(
      comparePerformanceReports(base, head, "19.3.1", "19.3.1", false, true)
    )
  ).toContain("workbench");
});
