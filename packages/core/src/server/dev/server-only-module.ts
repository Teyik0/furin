import { readFileSync, statSync } from "node:fs";

const SERVER_ONLY_IMPORT = /^\s*import\s+["'](?:@teyik0\/)?furin\/server-only["'];?\s*$/m;
const cache = new Map<string, { mtimeMs: number; serverOnly: boolean }>();

/**
 * Server-only modules hold server state and render no component, so development keeps their
 * file identity: versioning them would evaluate a second copy beside the server entry's.
 */
export function isServerOnlyModule(path: string): boolean {
  const stats = statSync(path, { throwIfNoEntry: false });
  if (!stats) {
    return false;
  }
  const { mtimeMs } = stats;
  const cached = cache.get(path);
  if (cached?.mtimeMs === mtimeMs) {
    return cached.serverOnly;
  }
  const serverOnly = SERVER_ONLY_IMPORT.test(readFileSync(path, "utf8"));
  cache.set(path, { mtimeMs, serverOnly });
  return serverOnly;
}
