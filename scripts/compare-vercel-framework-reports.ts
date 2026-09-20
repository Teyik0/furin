import { readFileSync, writeFileSync } from "node:fs";

interface VercelFrameworkReport {
  clientAssetCount: number;
  clientCssBytes: number;
  clientJavaScriptBytes: number;
  serverBootstrapBytes: number;
  serverHandlerBytes: number;
}

interface Budget {
  absoluteAllowance: number;
  key: keyof VercelFrameworkReport;
  relativeAllowance: number;
}

type UnknownVercelFrameworkReport = Partial<{
  [Key in keyof VercelFrameworkReport]: unknown;
}>;

const ELYSIA_2_MIGRATION_SERVER_LIMIT = 1_000_000;
const MAJOR_VERSION_PATTERN = /\d+/;
const budgets: Budget[] = [
  { absoluteAllowance: 4096, key: "serverHandlerBytes", relativeAllowance: 0.05 },
  { absoluteAllowance: 1024, key: "serverBootstrapBytes", relativeAllowance: 0.05 },
  { absoluteAllowance: 4096, key: "clientJavaScriptBytes", relativeAllowance: 0.03 },
  { absoluteAllowance: 2048, key: "clientCssBytes", relativeAllowance: 0.03 },
  { absoluteAllowance: 1, key: "clientAssetCount", relativeAllowance: 0 },
];

const reportKeys = budgets.map(({ key }) => key);

function readReport(path: string): VercelFrameworkReport {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof value !== "object" || value === null) {
    throw new Error(`Invalid Vercel framework report: ${path}`);
  }
  const candidate = value as UnknownVercelFrameworkReport;
  if (reportKeys.some((key) => !Number.isFinite(candidate[key]))) {
    throw new Error(`Invalid Vercel framework report: ${path}`);
  }
  return candidate as VercelFrameworkReport;
}

function majorVersion(version: string): number | undefined {
  const match = version.match(MAJOR_VERSION_PATTERN);
  return match === null ? undefined : Number(match[0]);
}

const [basePath, headPath, markdownPath, baseElysiaVersion, headElysiaVersion] =
  process.argv.slice(2);
if (
  basePath === undefined ||
  headPath === undefined ||
  markdownPath === undefined ||
  baseElysiaVersion === undefined ||
  headElysiaVersion === undefined
) {
  throw new Error(
    "Usage: bun scripts/compare-vercel-framework-reports.ts <base.json> <head.json> <report.md> <base-elysia> <head-elysia>"
  );
}

const base = readReport(basePath);
const head = readReport(headPath);
const isElysia2Migration =
  majorVersion(baseElysiaVersion) === 1 && majorVersion(headElysiaVersion) === 2;
let failed = false;
const lines = [
  "## Vercel framework benchmark budgets",
  "",
  "| Metric | Base | Head | Limit | Result |",
  "|---|---:|---:|---:|---|",
];

for (const budget of budgets) {
  const baseValue = base[budget.key];
  const headValue = head[budget.key];
  const relativeLimit = Math.ceil(
    baseValue * (1 + budget.relativeAllowance) + budget.absoluteAllowance
  );
  const limit =
    budget.key === "serverHandlerBytes" && isElysia2Migration
      ? ELYSIA_2_MIGRATION_SERVER_LIMIT
      : relativeLimit;
  const passed = headValue <= limit;
  failed ||= !passed;
  lines.push(
    `| ${budget.key} | ${baseValue} | ${headValue} | ${limit} | ${passed ? "pass" : "fail"} |`
  );
}

if (isElysia2Migration) {
  lines.push(
    "",
    `The server handler uses the one-time Elysia 1 → 2 migration cap (${ELYSIA_2_MIGRATION_SERVER_LIMIT} bytes). Subsequent Elysia 2 changes use the normal relative budget.`
  );
}

writeFileSync(markdownPath, `${lines.join("\n")}\n`);
if (failed) {
  process.exitCode = 1;
}
