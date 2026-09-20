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

const ELYSIA_2_MIGRATION_SERVER_LIMIT = 1_000_000;
const budgets: Budget[] = [
  { absoluteAllowance: 4096, key: "serverHandlerBytes", relativeAllowance: 0.05 },
  { absoluteAllowance: 1024, key: "serverBootstrapBytes", relativeAllowance: 0.05 },
  { absoluteAllowance: 4096, key: "clientJavaScriptBytes", relativeAllowance: 0.03 },
  { absoluteAllowance: 2048, key: "clientCssBytes", relativeAllowance: 0.03 },
  { absoluteAllowance: 1, key: "clientAssetCount", relativeAllowance: 0 },
];

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

const base = JSON.parse(readFileSync(basePath, "utf8")) as VercelFrameworkReport;
const head = JSON.parse(readFileSync(headPath, "utf8")) as VercelFrameworkReport;
const isElysia2Migration = baseElysiaVersion.startsWith("1.") && headElysiaVersion.startsWith("2.");
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
      ? Math.max(relativeLimit, ELYSIA_2_MIGRATION_SERVER_LIMIT)
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
