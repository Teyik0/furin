import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const WHITESPACE_RE = /\s+/;

function resolveDiskCheckPath(dir: string): string {
  let target = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);

  while (!existsSync(target)) {
    const parent = dirname(target);
    if (parent === target) {
      return target;
    }
    target = parent;
  }

  return target;
}

/**
 * Checks that at least `minBytes` of disk space are available at `dir`.
 * Fails open (returns true) if the check cannot be performed.
 */
export async function checkDiskSpace(dir: string, minBytes: number): Promise<boolean> {
  try {
    const target = resolveDiskCheckPath(dir);
    const child = Bun.spawn(["df", "-k", target], {
      stderr: "ignore",
      stdout: "pipe",
    });
    const [exitCode, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    if (exitCode !== 0) {
      return true;
    }

    const lines = output.trim().split("\n");
    const dataLine = lines.at(-1);

    if (!dataLine) {
      return true;
    }

    const parts = dataLine.trim().split(WHITESPACE_RE);
    // df -k output: Filesystem 1K-blocks Used Available Capacity Mounted
    const availableKb = Number(parts[3]);

    if (Number.isNaN(availableKb)) {
      return true;
    }

    return availableKb * 1024 >= minBytes;
  } catch {
    return true; // fail open — don't block scaffolding if df is unavailable
  }
}
