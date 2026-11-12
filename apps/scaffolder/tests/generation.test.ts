import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createContext, resolveTemplateSrc } from "../src/pipeline/context.ts";
import { stage5Generation } from "../src/pipeline/stages/5-generation.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("stage5Generation", () => {
  it("rejects duplicate destination paths before writing files", () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-"));
    tempDirs.push(targetDir);

    const sourcePath = resolve(import.meta.dir, "../templates/simple/src/server.ts.ejs");
    const ctx = createContext({
      routeStyle: "tanstack",
      fileTree: [
        {
          kind: "ejs",
          relativePath: "package.json",
          sourcePath,
        },
        {
          kind: "ejs",
          relativePath: "package.json",
          sourcePath,
        },
      ],
      projectName: "my-app",
      projectNameKebab: "my-app",
      projectNamePascal: "MyApp",
      targetDir,
    });

    return expect(stage5Generation(ctx)).rejects.toThrow(
      'Template contains duplicate destination "package.json" also used by "package.json".'
    );
  });

  it("rejects destination paths that escape the target directory", async () => {
    const parentDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-parent-"));
    tempDirs.push(parentDir);
    const targetDir = resolve(parentDir, "app");

    const sourcePath = resolve(import.meta.dir, "../templates/simple/src/server.ts.ejs");
    const ctx = createContext({
      routeStyle: "tanstack",
      fileTree: [
        {
          kind: "ejs",
          relativePath: "../escaped.ts",
          sourcePath,
        },
      ],
      projectName: "my-app",
      projectNameKebab: "my-app",
      projectNamePascal: "MyApp",
      targetDir,
    });

    await expect(stage5Generation(ctx)).rejects.toThrow(
      'Template destination "../escaped.ts" escapes the target directory.'
    );
    expect(existsSync(resolve(parentDir, "escaped.ts"))).toBe(false);
  });

  it("refuses to generate through a symbolic-link target", async () => {
    const parentDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-parent-"));
    const externalDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-external-"));
    tempDirs.push(parentDir, externalDir);
    const targetDir = resolve(parentDir, "app");
    symlinkSync(externalDir, targetDir, "dir");
    const sourcePath = resolve(import.meta.dir, "../templates/simple/src/server.ts.ejs");
    const ctx = createContext({
      routeStyle: "tanstack",
      fileTree: [{ kind: "ejs", relativePath: "server.ts", sourcePath }],
      projectName: "my-app",
      projectNameKebab: "my-app",
      projectNamePascal: "MyApp",
      targetDir,
    });

    await expect(stage5Generation(ctx)).rejects.toThrow("symbolic link");
    expect(existsSync(resolve(externalDir, "server.ts"))).toBe(false);
  });

  it("allows destination segments that begin with two dots", async () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-"));
    tempDirs.push(targetDir);

    const sourcePath = resolve(import.meta.dir, "../templates/simple/src/server.ts.ejs");
    const ctx = createContext({
      routeStyle: "tanstack",
      fileTree: [
        {
          kind: "ejs",
          relativePath: "..cache/server.ts",
          sourcePath,
        },
      ],
      projectName: "my-app",
      projectNameKebab: "my-app",
      projectNamePascal: "MyApp",
      targetDir,
    });

    await stage5Generation(ctx);

    expect(existsSync(resolve(targetDir, "..cache/server.ts"))).toBe(true);
  });

  it("rejects template source paths that escape the templates directory", () => {
    expect(() => resolveTemplateSrc("../package.json")).toThrow(
      'Template source "../package.json" escapes the templates directory.'
    );
  });

  it("copies static binary files without altering their bytes", async () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-"));
    tempDirs.push(targetDir);

    const sourcePath = resolve(import.meta.dir, "../templates/simple/public/favicon.ico");
    const ctx = createContext({
      routeStyle: "tanstack",
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

  it("writes package.json from resolved dependencies", async () => {
    const targetDir = mkdtempSync(resolve(tmpdir(), "create-furin-generation-"));
    tempDirs.push(targetDir);

    const dependencies = {
      "@teyik0/furin": "0.1.0-alpha.4",
      elysia: "^1.4.28",
      react: "^19.2.4",
    };
    const devDependencies = {
      "@biomejs/biome": "^2.4.12",
      typescript: "^6.0.2",
      ultracite: "^7.6.0",
    };
    const ctx = createContext({
      routeStyle: "tanstack",
      dependencies,
      devDependencies,
      fileTree: [
        {
          kind: "package-json",
          relativePath: "package.json",
        },
      ],
      projectName: "my-app",
      projectNameKebab: "my-app",
      projectNamePascal: "MyApp",
      targetDir,
    });

    await stage5Generation(ctx);

    const generated = await Bun.file(resolve(targetDir, "package.json")).json();

    expect(generated.name).toBe("my-app");
    expect(generated.engines.bun).toBe(">=1.4.0");
    expect(generated.scripts.dev).toBe("bun --hot src/server.ts");
    expect(generated.scripts.fix).toBe("ultracite fix");
    expect(generated.dependencies).toEqual(dependencies);
    expect(generated.devDependencies).toEqual(devDependencies);
    expect(Object.values(generated.devDependencies).every((version) => version !== "")).toBe(true);
  });
});
