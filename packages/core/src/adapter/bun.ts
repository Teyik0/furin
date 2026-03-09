import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { buildClient } from "../build/client";
import { buildTargetManifest, ensureDir, writeJsonFile } from "../build/shared";
import type { BuildAppOptions, TargetBuildManifest } from "../build/types";
import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";

export async function buildBunTarget(
  routes: ResolvedRoute[],
  rootDir: string,
  buildRoot: string,
  rootPath: string,
  serverEntry: string | null,
  options: BuildAppOptions
): Promise<TargetBuildManifest> {
  if (options.compile) {
    throw new Error(
      "[elyra] `--compile` for `--target bun` is not wired yet. Use the default split output for now."
    );
  }

  const target = "bun" satisfies BuildTarget;
  const targetManifest = buildTargetManifest(rootDir, buildRoot, target, serverEntry);
  const targetDir = resolve(rootDir, targetManifest.targetDir);

  rmSync(targetDir, { force: true, recursive: true });
  ensureDir(targetDir);

  await buildClient(routes, {
    outDir: targetDir,
    rootLayout: rootPath,
  });

  writeJsonFile(resolve(rootDir, targetManifest.manifestPath), targetManifest);
  return targetManifest;
}
