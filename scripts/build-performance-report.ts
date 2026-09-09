import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function run(command: string[], cwd: string): void {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    stderr: "inherit",
    stdout: "inherit",
  });
  if (result.exitCode !== 0) {
    throw new Error(`Performance report command failed (${result.exitCode}): ${command.join(" ")}`);
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
mkdirSync(dirname(outputPath), { recursive: true });

run(["bun", "install", "--frozen-lockfile"], projectDir);
run(["bun", "run", "--cwd", "packages/core", "build"], projectDir);
run(["bun", "run", "--cwd", "apps/docs", "build:analyze"], projectDir);
run(["bun", "run", "--cwd", "examples/weather", "build"], projectDir);
run(
  [
    "bun",
    measurementScript,
    join(projectDir, "apps/docs/.furin/build/analysis/bun-client.json"),
    join(projectDir, "apps/docs/.furin/build/bun/client"),
    "--json",
    outputPath,
    "--server-binary",
    join(projectDir, "examples/weather/.furin/build/bun/server"),
  ],
  projectDir
);
