import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serialize } from "node:v8";
import { frameworkSourceModule } from "../adapter/runtime-build.ts";
import type { FurinPlugin } from "../config.ts";
import type { RouteRegistrySnapshot } from "../plugin/route-registry.ts";
import type { RouteInstanceSpec } from "../plugin/route-tree.ts";
import { type DiscoveryPluginRequest, discoveryPlugins } from "./discovery-plugins.ts";
import type { BuildRoot, BuildRoute } from "./route-metadata.ts";
import { ensureDir } from "./shared.ts";

export interface DiscoveredApp extends RouteInstanceSpec {
  root: BuildRoot;
  routeRegistry: RouteRegistrySnapshot;
  routes: BuildRoute[];
}

/** Await process exit, not just its result: native import-time handles must be closed before AOT. */
export async function discoverPages(
  apps: RouteInstanceSpec[],
  rootDir: string,
  plugins: FurinPlugin[]
): Promise<DiscoveredApp[]> {
  const runtime = await discoveryPlugins(plugins);
  const buildDir = join(rootDir, ".furin/build");
  ensureDir(buildDir);
  const directory = mkdtempSync(join(buildDir, "discovery-"));
  const resultPath = join(directory, "pages.json");
  const child = Bun.spawn(
    [
      process.execPath,
      frameworkSourceModule("build/discover-pages-process.ts"),
      JSON.stringify({ apps, hooks: runtime.hooks, resultPath }),
    ],
    {
      cwd: rootDir,
      env: { ...process.env, NODE_ENV: "production" },
      serialization: "advanced",
      async ipc(request: DiscoveryPluginRequest, subprocess) {
        const response = await runtime.respond(request);
        if (subprocess.exitCode !== null) {
          return;
        }
        if (request.syncPath) {
          const temporary = `${request.syncPath}.tmp`;
          writeFileSync(temporary, serialize(response));
          renameSync(temporary, request.syncPath);
        } else {
          subprocess.send(response);
        }
      },
      stderr: "pipe",
      stdout: "pipe",
    }
  );
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`[furin] Route discovery failed:\n${stderr}\n${stdout}`);
    }
    return JSON.parse(readFileSync(resultPath, "utf8")) as DiscoveredApp[];
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
