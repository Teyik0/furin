import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { frameworkSourceModule } from "../adapter/runtime-build.ts";
import type { FurinRegistration } from "../server/registrations.ts";
import { toPosixPath } from "./shared.ts";

const DISCOVERY_PROCESS = frameworkSourceModule("build/discover-mounts-process.ts");

/**
 * The `furin()` mounts the server entry registers when evaluated. It runs in
 * a child process, so application code never loads into the build process.
 */
export async function discoverFurinMounts(
  serverEntry: string,
  rootDir: string
): Promise<FurinRegistration[]> {
  const resultPath = join(rootDir, ".furin", "build", `mounts-${crypto.randomUUID()}.json`);
  const child = Bun.spawn([process.execPath, DISCOVERY_PROCESS, serverEntry, resultPath], {
    cwd: rootDir,
    env: { ...process.env, NODE_ENV: "production" },
    stderr: "pipe",
    stdout: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(
        `[furin] Evaluating ${toPosixPath(serverEntry)} to find its furin() mounts failed:\n${stderr}\n${stdout}\n` +
          "Fix the server entry, or list the mounted apps in config.apps."
      );
    }
    return JSON.parse(readFileSync(resultPath, "utf8")) as FurinRegistration[];
  } finally {
    rmSync(resultPath, { force: true });
  }
}
