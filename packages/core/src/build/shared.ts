import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRouteRevalidate } from "../server/router/patterns.ts";
import type { ResolvedRoute } from "../server/router/types.ts";
import type { BuildRouteManifestEntry } from "./types";

// import.meta.dir/path/url are inlined at bundle time to the OUTPUT file's
// location — so relative paths break when bundled. import.meta.resolve() is a
// function call (not inlined), runs at runtime, and resolves through package
// exports. This is the Web-standard approach (Bun, Node 20.6+, browsers).
export const CLIENT_MODULE_PATH = fileURLToPath(import.meta.resolve("@teyik0/furin/client"));
export const LINK_MODULE_PATH = fileURLToPath(import.meta.resolve("@teyik0/furin/link"));
export const SEARCH_MODULE_PATH = fileURLToPath(import.meta.resolve("@teyik0/furin/search"));

/** Points the browser graph at the Furin client sources the server runs, not the `dist` bundle. */
export function resolveClientModuleSpecifiers(code: string): string {
  return code
    .replaceAll(`"@teyik0/furin/client"`, JSON.stringify(CLIENT_MODULE_PATH))
    .replaceAll(`'furin/client'`, JSON.stringify(CLIENT_MODULE_PATH))
    .replaceAll(`"@teyik0/furin/link"`, JSON.stringify(LINK_MODULE_PATH))
    .replaceAll(`'furin/link'`, JSON.stringify(LINK_MODULE_PATH))
    .replaceAll(`"@teyik0/furin/search"`, JSON.stringify(SEARCH_MODULE_PATH))
    .replaceAll(`'furin/search'`, JSON.stringify(SEARCH_MODULE_PATH));
}

export function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

export function toPosixPath(path: string): string {
  return path.replace(/\\/g, "/");
}

/** Writes a Bun build metafile (`furin build --analyze`) and logs where it went. */
export function writeBuildMetafile(path: string, metafile: Bun.BuildMetafile, label: string): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(metafile, null, 2)}\n`);
  console.log(`[furin] ${label} metafile: ${toPosixPath(path)}`);
}

export function copyDirRecursive(sourceDir: string, targetDir: string): void {
  rmSync(targetDir, { force: true, recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, dereference: true });
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
    hasStaticParams:
      route.page.staticParams !== undefined ||
      route.routeChain.some((entry) => entry.staticParams !== undefined),
    revalidate: resolveRouteRevalidate(route.page) ?? null,
  };
}
