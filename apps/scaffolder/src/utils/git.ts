/**
 * Runs a git command in the given directory without blocking the event loop.
 * Returns whether the command succeeded and any captured stderr output.
 */
async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "ignore",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  return {
    ok: exitCode === 0,
    stderr: stderr.trim(),
  };
}

/**
 * Initializes a new git repository and creates an initial commit.
 * Returns whether the repository was initialized and whether the initial
 * commit succeeded.
 */
export interface GitInitResult {
  committed: boolean;
  initialized: boolean;
  message?: string;
}

export async function initGitRepo(targetDir: string): Promise<GitInitResult> {
  if (!(await runGit(targetDir, ["init"])).ok) {
    return { committed: false, initialized: false };
  }
  if (!(await runGit(targetDir, ["add", "-A"])).ok) {
    return { committed: false, initialized: true };
  }

  const commitResult = await runGit(targetDir, [
    "commit",
    "-m",
    "chore: initial scaffold",
    "--allow-empty",
  ]);

  if (!commitResult.ok) {
    const missingIdentity =
      commitResult.stderr.includes("Author identity unknown") ||
      commitResult.stderr.includes("unable to auto-detect email address");

    return {
      committed: false,
      initialized: true,
      message: missingIdentity
        ? "Initial commit skipped: configure git user.name and user.email to enable automatic commits."
        : commitResult.stderr || undefined,
    };
  }

  return {
    committed: true,
    initialized: true,
  };
}
