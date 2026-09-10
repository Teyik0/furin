import { describe, expect, test } from "bun:test";
import {
  comparePerformanceReports,
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

    const comparison = comparePerformanceReports(base, head);

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

    const comparison = comparePerformanceReports(base, head);

    expect(comparison.regressions).toHaveLength(1);
    expect(comparison.regressions[0]).toMatchObject({
      allowedDeltaBytes: 2000,
      deltaBytes: 2001,
      label: "Initial JavaScript gzip",
      status: "fail",
    });
  });
});
