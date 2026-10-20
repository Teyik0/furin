import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initGitRepo } from "../src/utils/git";

const originalSpawn = Bun.spawn;

function getCommand(args: unknown): string[] {
  if (Array.isArray(args)) {
    return [...args];
  }

  if (args && typeof args === "object" && "cmd" in args) {
    const { cmd } = args as { cmd: string[] };
    return [...cmd];
  }

  throw new Error("Unexpected Bun.spawn arguments");
}

afterEach(() => {
  Bun.spawn = originalSpawn;
});

describe("initGitRepo", () => {
  it("keeps a successful git init when the initial commit fails", async () => {
    const callOrder: string[] = [];

    Bun.spawn = ((args) => {
      const gitArgs = getCommand(args).slice(1); // drop "git"
      callOrder.push(gitArgs[0] ?? "");

      const isCommit = gitArgs[0] === "commit";
      return {
        exited: Promise.resolve(isCommit ? 1 : 0),
        stderr: new Response(isCommit ? "Author identity unknown" : "").body,
      } as unknown as ReturnType<typeof Bun.spawn>;
    }) as typeof Bun.spawn;

    const result = await initGitRepo("/tmp/project");

    // Commands must fire in the right sequence
    expect(callOrder).toEqual(["init", "add", "commit"]);

    // Repo is initialised but commit was skipped
    expect(result.initialized).toBe(true);
    expect(result.committed).toBe(false);

    // The identity-unknown stderr must be translated into the friendly message
    expect(result.message).toContain("Initial commit skipped");
  });

  it("initializes the project's own repository when GIT_DIR points elsewhere", () => {
    // Git exports GIT_DIR to hooks run from a linked worktree; Bun.spawn
    // inherits the startup environment, so run the scaffolder in a child.
    const root = mkdtempSync(join(tmpdir(), "furin-git-"));
    const outer = join(root, "outer");
    const project = join(root, "project");
    mkdirSync(project);
    // The test's own git calls must not follow a GIT_DIR inherited from a hook either.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_"))
    );
    Bun.spawnSync(["git", "init", "-q", outer], { env });
    const gitModule = join(import.meta.dir, "../src/utils/git.ts");
    Bun.spawnSync(
      [
        process.execPath,
        "-e",
        `const { initGitRepo } = await import(${JSON.stringify(gitModule)}); await initGitRepo(${JSON.stringify(project)});`,
      ],
      { env: { ...env, GIT_DIR: join(outer, ".git") } }
    );

    const outerBare = Bun.spawnSync(["git", "-C", outer, "config", "core.bare"], {
      env,
    }).stdout.toString();
    expect(existsSync(join(project, ".git"))).toBe(true);
    expect(outerBare.trim()).toBe("false");
    rmSync(root, { force: true, recursive: true });
  });
});
