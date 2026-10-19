import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileRouteId, routeSourcePaths } from "../../src/plugin/route-tree.ts";
import { assertDistFresh } from "./dist.ts";

const FIXTURES_ROOT = resolve(import.meta.dir, "../fixtures/apps");
const TMP_ROOT = resolve(import.meta.dir, "../../.tmp-tests");
const ROUTE_ID_RE = /defineRoute\("[^"]*"\)/;

export interface TmpApp {
  cleanup: () => void;
  path: string;
}

function ensureTmpRoot(): void {
  if (!existsSync(TMP_ROOT)) {
    mkdirSync(TMP_ROOT, { recursive: true });
  }
}

function assertWithinAppPath(appPath: string, relativePath: string): string {
  const resolved = resolve(appPath, relativePath);
  const normalizedApp = resolve(appPath);
  const pathFromApp = relative(normalizedApp, resolved);
  if (pathFromApp === ".." || pathFromApp.startsWith(`..${sep}`) || isAbsolute(pathFromApp)) {
    throw new Error(`Path traversal detected: "${relativePath}" escapes app root`);
  }
  return resolved;
}

export function createTmpApp(fixtureName: string): TmpApp {
  // Fixture apps load Furin's browser client from dist/, in dev and production builds.
  assertDistFresh("client.js");
  ensureTmpRoot();

  const source = join(FIXTURES_ROOT, fixtureName);
  const path = mkdtempSync(join(TMP_ROOT, `${fixtureName}-`));
  cpSync(source, path, { recursive: true });

  return {
    cleanup: () => rmSync(path, { force: true, maxRetries: 50, recursive: true, retryDelay: 100 }),
    path,
  };
}

export function writeAppFile(appPath: string, relativePath: string, contents: string): void {
  const resolvedPath = assertWithinAppPath(appPath, relativePath);
  const directory = resolve(resolvedPath, "..");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolvedPath, contents);
}

/**
 * Rewrites every route id under `pagesDir` for an app mounted at `prefix`.
 * Route ids carry the prefix, so a fixture tree mounted under a prefix must
 * name its prefixed ids.
 */
export function keyPagesForPrefix(appPath: string, pagesDir: string, prefix: string): void {
  const instance = { pagesDir: assertWithinAppPath(appPath, pagesDir), prefix };
  for (const file of routeSourcePaths(instance)) {
    const id = JSON.stringify(fileRouteId(instance, file));
    writeFileSync(file, readFileSync(file, "utf8").replace(ROUTE_ID_RE, `defineRoute(${id})`));
  }
}

export function removeAppPath(appPath: string, relativePath: string): void {
  const resolvedPath = assertWithinAppPath(appPath, relativePath);
  rmSync(resolvedPath, { force: true, recursive: true });
}
