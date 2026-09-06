import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { BuildTarget } from "../config";
import type { ResolvedRoute } from "../server/router/types.ts";
import type { BuildRouteManifestEntry, TargetBuildManifest } from "./types";

// import.meta.dir/path/url are inlined at bundle time to the OUTPUT file's
// location — so relative paths break when bundled. import.meta.resolve() is a
// function call (not inlined), runs at runtime, and resolves through package
// exports. This is the Web-standard approach (Bun, Node 20.6+, browsers).
export const CLIENT_MODULE_PATH = fileURLToPath(import.meta.resolve("@teyik0/furin/client"));
export const LINK_MODULE_PATH = fileURLToPath(import.meta.resolve("@teyik0/furin/link"));
export const SEARCH_MODULE_PATH = fileURLToPath(import.meta.resolve("@teyik0/furin/search"));

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
