// `git rev-parse --local-env-vars`: set by git hooks, they would point every
// command at the caller's repository instead of the scaffolded project.
const REPOSITORY_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
]);

/**
 * Runs a git command in the given directory without blocking the event loop.
 * Returns whether the command succeeded and any captured stderr output.
 */
async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !REPOSITORY_ENV.has(name))
    ),
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
