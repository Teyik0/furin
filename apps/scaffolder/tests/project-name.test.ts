import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { ScaffolderError } from "../src/errors.ts";
import { ensureTargetDirIsSafe } from "../src/utils/project-name.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("ensureTargetDirIsSafe", () => {
  it("throws a ScaffolderError when the target path exists as a file", () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), "create-furin-project-name-"));
    tempDirs.push(tempDir);

    const targetFile = resolve(tempDir, "my-app");
    writeFileSync(targetFile, "existing file");

    expect(() => ensureTargetDirIsSafe(targetFile)).toThrow(ScaffolderError);
    expect(() => ensureTargetDirIsSafe(targetFile)).toThrow("is not a directory");
  });
});
