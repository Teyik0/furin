import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildBunTarget } from "../adapter/bun";
import { buildStaticTarget } from "../adapter/static";
import { BUILD_TARGETS, type BuildTarget } from "../config";
import { scanPages } from "../router";
import { scanFurinInstances } from "./scan-server";
import { ensureDir, toBuildRouteManifestEntry, toPosixPath } from "./shared";
import type { BuildAppOptions, BuildAppResult, BuildManifest } from "./types";

// biome-ignore lint/performance/noBarrelFile: intentional — build/index.ts is the public build API entry
export { buildClient } from "./client";
export { writeDevFiles } from "./hydrate";
export { patternToTypeString, schemaToTypeString, writeRouteTypes } from "./route-types";
export type {
  BuildAppOptions,
  BuildAppResult,
  BuildClientOptions,
  BuildManifest,
  BuildRouteManifestEntry,
  TargetBuildManifest,
} from "./types";

const IMPLEMENTED_TARGETS = ["bun", "static"] as const satisfies BuildTarget[];
export const BUILD_OUTPUT_DIR = ".furin/build";

function resolvePagesDirFromServer(serverEntry: string | null, rootDir: string): string | null {
  if (!serverEntry) {
    return null;
  }
  const detected = scanFurinInstances(serverEntry);
  if (detected.length === 0) {
    return null;
  }
  // Use the first detected pagesDir relative to rootDir
  return resolve(rootDir, detected[0] as string);
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const buildRoot = join(rootDir, BUILD_OUTPUT_DIR);
  const serverEntry = (() => {
    // Static-only builds don't need a server entry point
    if (options.target === "static") {
      return null;
    }
    if (options.serverEntry) {
      const resolved = resolve(rootDir, options.serverEntry);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
    const entry = resolve(rootDir, "src/server.ts");
    if (!existsSync(entry)) {
      throw new Error("[furin] Entrypoint server.ts not found");
    }
    return entry;
  })();

  // Register user plugins as runtime module loaders BEFORE scanPages.
  //
  // scanPages() calls import() on every page file, which triggers all their
  // static imports (e.g. ".mdx" files). If the loader is not yet registered
  // at that point, Bun caches the raw/unprocessed result — and that cached
  // value is reused for every subsequent import(), including prerenderSSG().
  //
  // Build-only plugins (e.g. bun-plugin-tailwind uses onBeforeParse which
  // doesn't exist in the runtime context) are skipped silently — they only
  // affect the Bun.build() client bundle, not server-side rendering.
  for (const plugin of options.plugins ?? []) {
    if ((plugin as import("../config").FurinPlugin).buildOnly) {
      continue;
    }
    try {
      Bun.plugin(plugin);
    } catch (err) {
      console.debug("[furin] Skipped plugin at runtime:", err);
    }
  }

  // Priority: explicit config > auto-detected from server entry > default
  const rawPagesDir =
    options.pagesDir ?? resolvePagesDirFromServer(serverEntry, rootDir) ?? "src/pages";
  const pagesDir = resolve(rootDir, rawPagesDir);

  const requestedTargets =
    options.target === "all"
      ? [...IMPLEMENTED_TARGETS]
      : [options.target].map((target) => {
          if (!(BUILD_TARGETS as readonly string[]).includes(target)) {
            throw new Error(`[furin] Unsupported build target "${target}"`);
          }
          return target as BuildTarget;
        });

  // scanPages throws if root.tsx is missing, so root is always defined here.
  const { root, routes } = await scanPages(pagesDir);

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
          root,
          serverEntry,
          options
        );
        break;
      case "static":
        manifest.targets.static = await buildStaticTarget(
          routes,
          rootDir,
          buildRoot,
          root,
          options
        );
        break;
      case "node":
      case "vercel":
      case "cloudflare":
        throw new Error(
          `[furin] \`--target ${target}\` is planned but not implemented yet in this branch.`
        );
      default:
        throw new Error(`[furin] Unsupported build target "${target}"`);
    }
  }

  writeFileSync(join(buildRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    targets: manifest.targets,
  };
}
