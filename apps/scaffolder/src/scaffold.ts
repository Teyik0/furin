import { mkdir } from "node:fs/promises";
import { copyTemplateDirectory } from "./fs.ts";
import { runBunInstall } from "./install.ts";
import { getTemplate } from "./template-registry.ts";
import { buildTemplateTokens } from "./template-tokens.ts";
import { ensureTargetDirIsSafe, resolveTargetDir } from "./validate.ts";

export interface CreateOptions {
  targetDir: string;
  template: "minimal" | "shadcn";
  yes: boolean;
}

export async function createProject(options: CreateOptions): Promise<{ targetDir: string }> {
  const resolvedTargetDir = resolveTargetDir(options.targetDir);
  const template = getTemplate(options.template);
  const tokens = buildTemplateTokens(resolvedTargetDir);

  ensureTargetDirIsSafe(resolvedTargetDir);
  await mkdir(resolvedTargetDir, { recursive: true });
  await copyTemplateDirectory(template.templateDir, resolvedTargetDir, tokens);
  runBunInstall(resolvedTargetDir);

  return { targetDir: resolvedTargetDir };
}
