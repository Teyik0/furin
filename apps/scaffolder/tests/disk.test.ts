import { afterEach, describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { checkDiskSpace } from "../src/utils/disk";

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

function fakeProcess(exitCode: number, stdout: string): ReturnType<typeof Bun.spawn> {
  return {
    exited: Promise.resolve(exitCode),
    stdout: new Response(stdout).body,
  } as unknown as ReturnType<typeof Bun.spawn>;
}

afterEach(() => {
  Bun.spawn = originalSpawn;
});

describe("checkDiskSpace", () => {
  it("checks the nearest existing ancestor for relative target paths", async () => {
    let command: string[] = [];

    Bun.spawn = ((args) => {
      command = getCommand(args);
      return fakeProcess(
        0,
        "Filesystem 1K-blocks Used Available Capacity Mounted\n/dev/disk 100 0 100 0% /\n"
      );
    }) as typeof Bun.spawn;

    expect(await checkDiskSpace("new-project/nested", 1024)).toBe(true);
    expect(command).toEqual(["df", "-k", resolve(process.cwd())]);
  });

  it("returns false when available space is below the required minimum", async () => {
    // 50 KB available, 100 KB required
    Bun.spawn = ((_args) =>
      fakeProcess(
        0,
        "Filesystem 1K-blocks Used Available Capacity Mounted\n/dev/disk 200 150 50 75% /\n"
      )) as typeof Bun.spawn;

    expect(await checkDiskSpace("/tmp", 100 * 1024)).toBe(false);
  });

  it("returns true (fail-open) when df exits with a non-zero code", async () => {
    Bun.spawn = ((_args) => fakeProcess(1, "")) as typeof Bun.spawn;

    expect(await checkDiskSpace("/tmp", 1024)).toBe(true);
  });

  it("returns true (fail-open) when df output is malformed", async () => {
    Bun.spawn = ((_args) => fakeProcess(0, "unexpected garbage output\n")) as typeof Bun.spawn;

    expect(await checkDiskSpace("/tmp", 1024)).toBe(true);
  });
});
