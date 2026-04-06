import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ScaffolderError } from "../errors.ts";

const IGNORED_DIRECTORY_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);

export function resolveTargetDir(input: string): string {
  if (!input.trim()) {
    throw new ScaffolderError("Target directory is required");
  }
  return resolve(process.cwd(), input);
}

/**
 * Ensures the target directory is safe to scaffold into.
 * Throws if it's a non-empty existing directory.
 */
export function ensureTargetDirIsSafe(targetDir: string): void {
  const root = resolve(process.cwd());
  const resolved = resolve(targetDir);

  if (resolved === root) {
    const entries = getVisibleEntries(resolved);
    if (entries.length > 0) {
      throw new ScaffolderError("Refusing to scaffold into the current non-empty directory");
    }
    return;
  }

  if (existsSync(resolved)) {
    if (!statSync(resolved).isDirectory()) {
      throw new ScaffolderError(
        `Target path "${basename(resolved)}" already exists and is not a directory`
      );
    }

    const entries = getVisibleEntries(resolved);
    if (entries.length > 0) {
      throw new ScaffolderError(
        `Target directory "${basename(resolved)}" already exists and is not empty`
      );
    }
  }
}

function getVisibleEntries(targetDir: string): string[] {
  return readdirSync(targetDir).filter((entry) => !IGNORED_DIRECTORY_ENTRIES.has(entry));
}
