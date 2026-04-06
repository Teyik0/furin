const WHITESPACE_RE = /\s+/;

/**
 * Checks that at least `minBytes` of disk space are available at `dir`.
 * Fails open (returns true) if the check cannot be performed.
 */
export function checkDiskSpace(dir: string, minBytes: number): boolean {
  try {
    const target = dir.startsWith("/") ? dir : process.cwd();
    const result = Bun.spawnSync(["df", "-k", target], {
      stderr: "pipe",
      stdout: "pipe",
    });

    if (result.exitCode !== 0) {
      return true;
    }

    const output = new TextDecoder().decode(result.stdout);
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
