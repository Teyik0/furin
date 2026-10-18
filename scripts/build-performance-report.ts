import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

async function run(command: string[], cwd: string): Promise<void> {
  const exitCode = await Bun.spawn({
    cmd: command,
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  }).exited;
  if (exitCode !== 0) {
    throw new Error(`Performance report command failed (${exitCode}): ${command.join(" ")}`);
  }
}

const [, , projectPath, reportPath] = Bun.argv;
if (projectPath === undefined || reportPath === undefined) {
  console.error("Usage: bun scripts/build-performance-report.ts <project-checkout> <report.json>");
  process.exit(1);
}

const projectDir = resolve(projectPath);
const outputPath = resolve(reportPath);
const measurementScript = join(import.meta.dirname, "measure-client-bundle.ts");
const serverFilename = process.platform === "win32" ? "server.exe" : "server";
mkdirSync(dirname(outputPath), { recursive: true });

await run(["bun", "install", "--frozen-lockfile"], projectDir);
await run(["bun", "run", "--cwd", "packages/core", "build"], projectDir);
await run(["bun", "run", "--cwd", "apps/docs", "build:analyze"], projectDir);
await run(["bun", "run", "--cwd", "examples/weather", "build"], projectDir);
await run(
  [
    "bun",
    measurementScript,
    join(projectDir, "apps/docs/.furin/build/analysis/bun-client.json"),
    join(projectDir, "apps/docs/.furin/build/bun/client"),
    "--json",
    outputPath,
    "--server-binary",
    join(projectDir, "examples/weather/.furin/build/bun", serverFilename),
  ],
  projectDir
);
