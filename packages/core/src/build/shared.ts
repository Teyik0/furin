import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../router";
import type { BuildRouteManifestEntry, TargetBuildManifest } from "./types";

export const CLIENT_MODULE_PATH = resolve(import.meta.dir, "../client.ts").replace(/\\/g, "/");
export const LINK_MODULE_PATH = resolve(import.meta.dir, "../link.tsx").replace(/\\/g, "/");

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export function collectFilesRecursive(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesRecursive(absolutePath));
      continue;
    }
    if (entry.isFile()) {
      files.push(absolutePath);
    }
  }

  return files.sort();
}

export function copyDirRecursive(sourceDir: string, targetDir: string): void {
  rmSync(targetDir, { force: true, recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
}

export function toBuildRouteManifestEntry(
  route: ResolvedRoute,
  rootDir: string
): BuildRouteManifestEntry {
  return {
    pattern: route.pattern,
    mode: route.mode,
    pagePath: toPosixPath(relative(rootDir, route.path)),
    hasLayout: route.routeChain.some((entry) => !!entry.layout),
    hasStaticParams: !!route.page?.staticParams,
    revalidate: route.page?._route.revalidate ?? null,
  };
}

export function buildTargetManifest(
  rootDir: string,
  buildRoot: string,
  target: BuildTarget,
  serverEntry: string | null
): TargetBuildManifest {
  const targetDir = join(buildRoot, target);

  return {
    buildId: "", // populated by adapter after buildClient() completes
    generatedAt: new Date().toISOString(),
    targetDir: toPosixPath(relative(rootDir, targetDir)),
    clientDir: toPosixPath(relative(rootDir, join(targetDir, "client"))),
    templatePath: toPosixPath(relative(rootDir, join(targetDir, "client", "index.html"))),
    serverPath: null,
    serverEntry: serverEntry ? toPosixPath(relative(rootDir, serverEntry)) : null,
  };
}
