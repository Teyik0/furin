import { resolve } from "node:path";
import { cancel, isCancel, text } from "@clack/prompts";
import { toKebabCase, toPascalCase } from "../../engine/helpers.ts";
import { ScaffolderError } from "../../errors.ts";
import { getPackageCatalog } from "../../package-catalog.ts";
import { checkDiskSpace } from "../../utils/disk.ts";
import { ensureTargetDirIsSafe } from "../../utils/project-name.ts";
import type { PipelineContext } from "../context.ts";

const MIN_DISK_BYTES = 50 * 1024 * 1024; // 50 MB

export async function stage1Analysis(ctx: PipelineContext): Promise<void> {
  // ── Project name ───────────────────────────────────────────────────────
  if (!ctx.projectName) {
    const name = await text({
      message: "What is the project name?",
      placeholder: "my-furin-app",
      validate(value) {
        if (!value?.trim()) {
          return "Project name is required.";
        }
        if (value.includes("/")) {
          return "Name cannot contain slashes.";
        }
        if (value.length > 214) {
          return "Name is too long (npm limit: 214 chars).";
        }
      },
    });

    if (isCancel(name)) {
      cancel("Scaffolding cancelled.");
      process.exit(0);
    }

    ctx.projectName = (name as string).trim();
  }

  // ── Derive variants ────────────────────────────────────────────────────
  ctx.projectNameKebab = toKebabCase(ctx.projectName);
  ctx.projectNamePascal = toPascalCase(ctx.projectName);
  ctx.targetDir = resolve(process.cwd(), ctx.projectNameKebab);

  if (!ctx.projectNameKebab) {
    throw new ScaffolderError(`Cannot derive a valid project name from "${ctx.projectName}"`);
  }

  // ── Directory safety check ─────────────────────────────────────────────
  ensureTargetDirIsSafe(ctx.targetDir);

  // ── Disk space check ───────────────────────────────────────────────────
  ctx.diskSpaceOk = await checkDiskSpace(ctx.targetDir, MIN_DISK_BYTES);
  if (!ctx.diskSpaceOk) {
    throw new ScaffolderError("Insufficient disk space. Need at least 50 MB.");
  }

  // ── Furin version from catalog ─────────────────────────────────────────
  const catalog = getPackageCatalog();
  ctx.furinVersion = catalog["@teyik0/furin"];
}
