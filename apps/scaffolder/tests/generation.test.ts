import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createContext } from "../src/pipeline/context.ts";
import { stage5Generation } from "../src/pipeline/stages/5-generation.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("stage5Generation", () => {
  it("copies static binary files without altering their bytes", async () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-"));
    tempDirs.push(targetDir);

    const sourcePath = resolve(import.meta.dir, "../templates/simple/public/favicon.ico");
    const ctx = createContext({
      fileTree: [
        {
          kind: "static",
          relativePath: "public/favicon.ico",
          sourcePath,
        },
      ],
      projectName: "my-app",
      projectNameKebab: "my-app",
      projectNamePascal: "MyApp",
      targetDir,
    });

    await stage5Generation(ctx);

    const sourceBytes = await Bun.file(sourcePath).bytes();
    const generatedBytes = await Bun.file(resolve(targetDir, "public/favicon.ico")).bytes();

    expect(Array.from(generatedBytes)).toEqual(Array.from(sourceBytes));
  });
});
