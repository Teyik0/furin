import { readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

// Sweep temp apps left behind by killed or crashed runs. Only entries older
// than an hour are removed, so an overlapping run never loses live fixtures.
const TMP_ROOT = resolve(import.meta.dir, "../../.tmp-tests");
const STALE_TMP_MS = 60 * 60 * 1000;

function sweepStaleTmpEntries(): void {
  let entries: string[];
  try {
    entries = readdirSync(TMP_ROOT);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_TMP_MS;
  for (const entry of entries) {
    const path = join(TMP_ROOT, entry);
    try {
      if (statSync(path).mtimeMs < cutoff) {
        rmSync(path, { force: true, recursive: true });
      }
    } catch {
      // Another process removed or is removing it concurrently.
    }
  }
}

sweepStaleTmpEntries();
