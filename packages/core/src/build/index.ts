import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildBunTarget } from "../adapter/bun";
import { BUILD_TARGETS, type BuildTarget } from "../config";
import { scanPages } from "../router";
import { scanElyraInstances } from "./scan-server";
import {
  ensureDir,
  toBuildRouteManifestEntry,
  toPosixPath,
} from "./shared";
import type {
  BuildAppOptions,
  BuildAppResult,
  BuildManifest,
} from "./types";

export type {
  BuildAppOptions,
  BuildAppResult,
  BuildClientOptions,
  BuildManifest,
  BuildRouteManifestEntry,
  TargetBuildManifest,
} from "./types";
export { buildClient } from "./client";
export { writeDevFiles } from "./hydrate";
export { patternToTypeString, schemaToTypeString, writeRouteTypes } from "./route-types";

const IMPLEMENTED_TARGETS = ["bun"] as const satisfies BuildTarget[];
export const BUILD_OUTPUT_DIR = ".elyra/build";

function resolvePagesDirFromServer(serverEntry: string | null, rootDir: string): string | null {
  if (!serverEntry) return null;
  const detected = scanElyraInstances(serverEntry);
  if (detected.length === 0) return null;
  // Use the first detected pagesDir relative to rootDir
  return resolve(rootDir, detected[0] as string);
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const buildRoot = join(rootDir, BUILD_OUTPUT_DIR);
  const serverEntry = (() => {
    if (options.serverEntry) {
      const resolved = resolve(rootDir, options.serverEntry);
      if (existsSync(resolved)) return resolved;
    }
    const serverEntry = resolve(rootDir, "src/server.ts");
    if (!existsSync(serverEntry)) {
      throw new Error("[elyra] Entrypoint server.ts not found");
    }
    return serverEntry
  })();

  // Priority: explicit config > auto-detected from server entry > default
  const rawPagesDir =
    options.pagesDir ?? resolvePagesDirFromServer(serverEntry, rootDir) ?? "src/pages";
  const pagesDir = resolve(rootDir, rawPagesDir);

  const requestedTargets =
    options.target === "all"
      ? [...IMPLEMENTED_TARGETS]
      : [options.target].map((target) => {
          if (!(BUILD_TARGETS as readonly string[]).includes(target)) {
            throw new Error(`[elyra] Unsupported build target "${target}"`);
          }
          return target as BuildTarget;
        });

  const { root, routes } = await scanPages(pagesDir);
  if (!root) {
    throw new Error(
      "[elyra] No root layout found. Create a root.tsx in your pages directory with a layout component."
    );
  }

  ensureDir(buildRoot);

  const manifest: BuildManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootDir: toPosixPath(rootDir),
    pagesDir: toPosixPath(relative(rootDir, pagesDir)),
    rootPath: toPosixPath(relative(rootDir, root.path)),
    serverEntry: serverEntry ? toPosixPath(relative(rootDir, serverEntry)) : null,
    routes: routes.map((route) => toBuildRouteManifestEntry(route, rootDir)),
    targets: {},
  };

  for (const target of requestedTargets) {
    switch (target) {
      case "bun":
        manifest.targets.bun = await buildBunTarget(
          routes,
          rootDir,
          buildRoot,
          root.path,
          serverEntry,
          options
        );
        break;
      case "node":
      case "vercel":
      case "cloudflare":
        throw new Error(
          `[elyra] \`--target ${target}\` is planned but not implemented yet in this branch.`
        );
      default:
        throw new Error(`[elyra] Unsupported build target "${target}"`);
    }
  }

  writeFileSync(join(buildRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`)

  return {
    manifest,
    targets: manifest.targets,
  };
}
