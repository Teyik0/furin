import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ScaffolderError } from "./errors.ts";

const IGNORED_DIRECTORY_ENTRIES = new Set([".DS_Store", "Thumbs.db"]);

export function normalizePackageName(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");

  if (!normalized) {
    throw new ScaffolderError(`Cannot derive a valid package name from "${input}"`);
  }

  return normalized;
}

export function resolveTargetDir(input: string): string {
  if (!input.trim()) {
    throw new ScaffolderError("Target directory is required");
  }

  return resolve(process.cwd(), input);
}

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
