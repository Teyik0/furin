import { afterEach, describe, expect, it } from "bun:test";
import { initGitRepo } from "../src/utils/git";

const originalSpawnSync = Bun.spawnSync;

function getCommand(args: unknown): string[] {
  if (Array.isArray(args)) {
    return [...args];
  }

  if (args && typeof args === "object" && "cmd" in args) {
    const { cmd } = args as { cmd: string[] };
    return [...cmd];
  }

  throw new Error("Unexpected Bun.spawnSync arguments");
}

afterEach(() => {
  Bun.spawnSync = originalSpawnSync;
});

describe("initGitRepo", () => {
  it("keeps a successful git init when the initial commit fails", () => {
    const encoder = new TextEncoder();
    const callOrder: string[] = [];

    Bun.spawnSync = ((args) => {
      const gitArgs = getCommand(args).slice(1); // drop "git"
      callOrder.push(gitArgs[0] ?? "");

      const isCommit = gitArgs[0] === "commit";
      return {
        exitCode: isCommit ? 1 : 0,
        success: !isCommit,
        stderr: isCommit ? encoder.encode("Author identity unknown") : new Uint8Array(),
        stdout: new Uint8Array(),
      } as ReturnType<typeof Bun.spawnSync>;
    }) as typeof Bun.spawnSync;

    const result = initGitRepo("/tmp/project");

    // Commands must fire in the right sequence
    expect(callOrder).toEqual(["init", "add", "commit"]);

    // Repo is initialised but commit was skipped
    expect(result.initialized).toBe(true);
    expect(result.committed).toBe(false);

    // The identity-unknown stderr must be translated into the friendly message
    expect(result.message).toContain("Initial commit skipped");
  });
});
