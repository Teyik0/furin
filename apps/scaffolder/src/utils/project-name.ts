import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ScaffolderError } from "../errors.ts";

const IGNORED_DIRECTORY_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);
const PATH_SEPARATOR_RE = /[\\/]/;

export function getProjectNameValidationError(value: string | undefined): string | undefined {
  const normalized = value?.trim();

  if (!normalized) {
    return "Project name is required.";
  }

  if (PATH_SEPARATOR_RE.test(normalized)) {
    return "Name cannot contain slashes.";
  }

  if (normalized.length > 214) {
    return "Name is too long (npm limit: 214 chars).";
  }
}

export function validateProjectName(value: string): string {
  const error = getProjectNameValidationError(value);
  if (error) {
    throw new ScaffolderError(error);
  }

  return value.trim();
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
