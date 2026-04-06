/**
 * Runs a git command synchronously in the given directory.
 * Returns true if the command succeeded, false otherwise.
 */
function runGit(cwd: string, args: string[]): boolean {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  return result.exitCode === 0;
}

/**
 * Initializes a new git repository and creates an initial commit.
 * Returns true if all git operations succeeded.
 */
export function initGitRepo(targetDir: string): boolean {
  if (!runGit(targetDir, ["init"])) {
    return false;
  }
  if (!runGit(targetDir, ["add", "-A"])) {
    return false;
  }
  if (!runGit(targetDir, ["commit", "-m", "chore: initial scaffold", "--allow-empty"])) {
    return false;
  }
  return true;
}
