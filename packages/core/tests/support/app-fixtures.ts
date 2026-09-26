import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const FIXTURES_ROOT = resolve(import.meta.dir, "../fixtures/apps");
const TMP_ROOT = resolve(import.meta.dir, "../../.tmp-tests");

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
  ensureTmpRoot();

  const source = join(FIXTURES_ROOT, fixtureName);
  const path = mkdtempSync(join(TMP_ROOT, `${fixtureName}-`));
  cpSync(source, path, { recursive: true });

  return {
    cleanup: () => rmSync(path, { force: true, maxRetries: 10, recursive: true, retryDelay: 100 }),
    path,
  };
}

export function writeAppFile(appPath: string, relativePath: string, contents: string): void {
  const resolvedPath = assertWithinAppPath(appPath, relativePath);
  const directory = resolve(resolvedPath, "..");
  mkdirSync(directory, { recursive: true });
  writeFileSync(resolvedPath, contents);
}

export function removeAppPath(appPath: string, relativePath: string): void {
  const resolvedPath = assertWithinAppPath(appPath, relativePath);
  rmSync(resolvedPath, { force: true, recursive: true });
}
