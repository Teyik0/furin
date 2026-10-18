import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { clientDirNameForPrefix } from "../../shared/prefix.ts";

export function resolveClientDirFromArgv(prefix: string): string {
  const dirName = clientDirNameForPrefix(prefix);
  return (
    resolveClientDirFromEnv(dirName) ??
    resolveClientDirFromModuleUrl(dirName) ??
    resolveClientDirFromProcessArgs(dirName) ??
    resolveFallbackClientDir(dirName)
  );
}

function resolveClientDirFromEnv(dirName: string): string | null {
  const envClientDir = process.env.FURIN_CLIENT_DIR;
  if (!envClientDir) {
    return null;
  }
  const base = envClientDir.startsWith("/") ? envClientDir : resolve(process.cwd(), envClientDir);
  // FURIN_CLIENT_DIR points at the ROOT instance's client dir; sibling
  // instances live next to it under their own dir name.
  return dirName === "client" ? base : join(dirname(base), dirName);
}

function resolveClientDirFromModuleUrl(dirName: string): string | null {
  try {
    const moduleUrl = new URL(import.meta.url);
    if (moduleUrl.protocol !== "file:") {
      return null;
    }
    const modulePath = fileURLToPath(moduleUrl);
    if (modulePath.includes("/$bunfs/")) {
      return null;
    }
    const moduleClientDir = join(dirname(modulePath), dirName);
    if (existsSync(join(moduleClientDir, "index.html"))) {
      return moduleClientDir;
    }
  } catch {
    // ignore, fallback to argv-based resolution
  }
  return null;
}

function resolveClientDirFromProcessArgs(dirName: string): string | null {
  const candidates = [
    process.argv[1],
    process.argv[0],
    (process as { argv0?: string }).argv0,
    process.execPath,
  ].filter((value): value is string => typeof value === "string" && value.length > 0);

  for (const candidate of candidates) {
    const resolved = resolveClientDirFromCandidate(candidate, dirName);
    if (resolved) {
      return resolved;
    }
  }

  return null;
}

function resolveClientDirFromCandidate(candidate: string, dirName: string): string | null {
  const name = basename(candidate);
  if (name === "bun" || name === "node") {
    return null;
  }
  if (candidate.includes("/$bunfs/") || candidate.startsWith("bunfs:")) {
    return null;
  }

  const absolute = candidate.startsWith("/") ? candidate : resolve(process.cwd(), candidate);
  if (existsSync(absolute)) {
    const clientDir = join(dirname(absolute), dirName);
    if (existsSync(join(clientDir, "index.html"))) {
      return clientDir;
    }
  }

  if (!candidate.includes("/")) {
    return resolveClientDirFromPath(candidate, dirName);
  }

  return null;
}

function resolveClientDirFromPath(candidate: string, dirName: string): string | null {
  const pathEntries = process.env.PATH?.split(delimiter) ?? [];
  for (const dir of pathEntries) {
    const fullPath = join(dir, candidate);
    if (existsSync(fullPath)) {
      const clientDir = join(dirname(fullPath), dirName);
      if (existsSync(join(clientDir, "index.html"))) {
        return clientDir;
      }
    }
  }
  return null;
}

function resolveFallbackClientDir(dirName: string): string {
  const defaultClientDir = resolve(process.cwd(), ".furin/build/bun", dirName);
  if (existsSync(join(defaultClientDir, "index.html"))) {
    return defaultClientDir;
  }

  return join(process.cwd(), dirName);
}
