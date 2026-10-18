import { afterEach, describe, expect, it } from "bun:test";
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
});
