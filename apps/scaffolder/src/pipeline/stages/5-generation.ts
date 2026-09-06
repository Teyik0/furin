import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spinner } from "@clack/prompts";
import { buildEjsVars, renderEjsFile } from "../../engine/renderer.ts";
import { ensureTargetDirIsSafe } from "../../utils/project-name.ts";
import { assertPathInsideDirectory, type PipelineContext, TEMPLATES_DIR } from "../context.ts";

function resolveDestinationPath(ctx: PipelineContext, relativePath: string): string {
  const destPath = resolve(ctx.targetDir, relativePath);
  assertPathInsideDirectory(
    ctx.targetDir,
    destPath,
    `Template destination "${relativePath}" escapes the target directory.`
  );
  return destPath;
}

function assertTemplateSourceInsideTemplates(sourcePath: string): void {
  assertPathInsideDirectory(
    TEMPLATES_DIR,
    sourcePath,
    `Template source "${sourcePath}" escapes the templates directory.`
  );
}

function assertUniqueDestinations(ctx: PipelineContext): void {
  const seen = new Map<string, string>();

  for (const file of ctx.fileTree) {
    const destPath = resolveDestinationPath(ctx, file.relativePath);
    if (seen.has(destPath)) {
      throw new Error(
        `Template contains duplicate destination "${file.relativePath}" also used by "${seen.get(destPath)}".`
      );
    }
    seen.set(destPath, file.relativePath);
  }
}

interface PackageJsonContent {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  engines: {
    bun: string;
  };
  name: string;
  private: boolean;
  scripts: {
    build: string;
    dev: string;
    fix: string;
    start: string;
    tscheck: string;
  };
  type: "module";
  version: string;
}

function buildPackageJson(ctx: PipelineContext): string {
  const packageJson: PackageJsonContent = {
    dependencies: ctx.dependencies,
    devDependencies: ctx.devDependencies,
    engines: {
      bun: ">=1.4.0",
    },
    name: ctx.projectNameKebab,
    private: true,
    scripts: {
      build: "furin build --target bun --compile embed",
      dev: "bun --hot src/server.ts",
      fix: "ultracite fix",
      start: "./.furin/build/bun/server",
      tscheck: "tsc --noEmit",
    },
    type: "module",
    version: "0.1.0",
  };

  return `${JSON.stringify(packageJson, null, 2)}\n`;
}

export async function stage5Generation(ctx: PipelineContext): Promise<void> {
  if (ctx.fileTree.length === 0) {
    throw new Error("File tree is empty — stage3Design must run first.");
  }

  assertUniqueDestinations(ctx);
  ensureTargetDirIsSafe(ctx.targetDir);

  const s = spinner();
  s.start("Creating project files…");

  try {
    const vars = buildEjsVars(ctx);

    // Ensure the target directory exists
    await mkdir(ctx.targetDir, { recursive: true });

    const writtenFiles = await Promise.all(
      ctx.fileTree.map(async (file) => {
        const destPath = resolveDestinationPath(ctx, file.relativePath);
        await mkdir(dirname(destPath), { recursive: true });

        if (file.kind === "package-json") {
          const content = buildPackageJson(ctx);
          await Bun.write(destPath, content);
          file.content = content;
        } else if (file.kind === "ejs") {
          assertTemplateSourceInsideTemplates(file.sourcePath);
          const content = await renderEjsFile(file.sourcePath, vars);
          await Bun.write(destPath, content);
          file.content = content;
        } else {
          assertTemplateSourceInsideTemplates(file.sourcePath);
          const content = await Bun.file(file.sourcePath).bytes();
          await Bun.write(destPath, content);
        }

        return destPath;
      })
    );
    ctx.writtenFiles.push(...writtenFiles);

    s.stop(`Created ${ctx.writtenFiles.length} files.`);
  } catch (error) {
    s.stop("File generation failed.");
    throw error;
  }
}
