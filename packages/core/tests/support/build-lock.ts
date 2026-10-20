// biome-ignore-all lint/performance/noAwaitInLoops: build lock helper polls sequentially until the lock is released
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const LOCK_DIR = resolve(import.meta.dir, "../../.tmp-tests/build.lock");
const STALE_LOCK_MS = 60_000;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// A lock is stale when its owner process is gone. The owner file is written
// right after mkdir, so fall back to age only while it is missing or partial.
function isLockStale(): boolean {
  let pid = Number.NaN;
  try {
    pid = Number.parseInt(readFileSync(join(LOCK_DIR, "owner"), "utf8"), 10);
  } catch {
    // Owner file not written yet.
  }
  if (Number.isNaN(pid)) {
    return Date.now() - statSync(LOCK_DIR).mtimeMs > STALE_LOCK_MS;
  }
  return !isProcessAlive(pid);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function acquireBuildTestLock(): Promise<() => void> {
  for (;;) {
    try {
      mkdirSync(LOCK_DIR, { recursive: false });
      writeFileSync(join(LOCK_DIR, "owner"), `${process.pid}\n`);
      return () => {
        rmSync(LOCK_DIR, { force: true, recursive: true });
      };
    } catch {
      if (!existsSync(LOCK_DIR)) {
        await delay(5);
        continue;
      }

      let stale: boolean;
      try {
        stale = isLockStale();
      } catch {
        await delay(5);
        continue;
      }
      if (stale) {
        rmSync(LOCK_DIR, { force: true, recursive: true });
        continue;
      }

      await delay(10);
    }
  }
}

export async function withBuildTestLock<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireBuildTestLock();
  try {
    return await run();
  } finally {
    release();
  }
}
