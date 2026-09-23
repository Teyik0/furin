import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

interface VercelFrameworkReport {
  clientAssetCount: number;
  clientCssBytes: number;
  clientJavaScriptBytes: number;
  serverBootstrapBytes: number;
  serverHandlerBytes: number;
}

const CHUNK_FILE = /^chunk-.*\.js$/;

export function measureServerBundleBytes(functionDir: string): number {
  return readdirSync(functionDir)
    .filter((file) => CHUNK_FILE.test(file))
    .reduce(
      (total, file) => total + statSync(join(functionDir, file)).size,
      statSync(join(functionDir, "handler.js")).size
    );
}

if (import.meta.main) {
  const [reportPath, functionDir] = Bun.argv.slice(2);
  if (reportPath === undefined || functionDir === undefined) {
    throw new Error(
      "Usage: bun scripts/measure-vercel-server-bundle.ts <report.json> <function-dir>"
    );
  }
  const report = (await Bun.file(reportPath).json()) as VercelFrameworkReport;
  report.serverHandlerBytes = measureServerBundleBytes(functionDir);
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
