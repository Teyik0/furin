import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTemplateTokens } from "../src/template-tokens.ts";
import { ensureTargetDirIsSafe, normalizePackageName } from "../src/validate.ts";

describe("template tokens", () => {
  test("derive project and package names from the target directory", () => {
    const tokens = buildTemplateTokens("/tmp/Hello Furin App");

    expect(tokens.projectName).toBe("Hello Furin App");
    expect(tokens.packageName).toBe("hello-furin-app");
    expect(tokens.furinVersion).toBeTruthy();
  });
});

describe("validate", () => {
  test("normalizes package names", () => {
    expect(normalizePackageName("Hello Furin App")).toBe("hello-furin-app");
  });

  test("rejects non-empty target directories", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "create-furin-non-empty-"));
    writeFileSync(join(targetDir, "README.md"), "occupied");

    expect(() => ensureTargetDirIsSafe(targetDir)).toThrow("already exists and is not empty");
  });

  test("allows ignored files only", () => {
    const targetDir = mkdtempSync(join(tmpdir(), "create-furin-ignored-"));
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, ".DS_Store"), "ignored");

    expect(() => ensureTargetDirIsSafe(targetDir)).not.toThrow();
  });
});
