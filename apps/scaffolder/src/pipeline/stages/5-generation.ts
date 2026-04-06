import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { spinner } from "@clack/prompts";
import { buildEjsVars, renderEjsFile } from "../../engine/renderer.ts";
import type { PipelineContext } from "../context.ts";

export async function stage5Generation(ctx: PipelineContext): Promise<void> {
  if (ctx.fileTree.length === 0) {
    throw new Error("File tree is empty — stage3Design must run first.");
  }

  const s = spinner();
  s.start("Creating project files…");

  try {
    const vars = buildEjsVars(ctx);

    // Ensure the target directory exists
    await mkdir(ctx.targetDir, { recursive: true });

    for (const file of ctx.fileTree) {
      const destPath = resolve(ctx.targetDir, file.relativePath);
      await mkdir(dirname(destPath), { recursive: true });

      if (file.kind === "ejs") {
        const content = await renderEjsFile(file.sourcePath, vars);
        await Bun.write(destPath, content);
        file.content = content;
      } else {
        const content = await Bun.file(file.sourcePath).bytes();
        await Bun.write(destPath, content);
      }

      ctx.writtenFiles.push(destPath);
    }

    s.stop(`Created ${ctx.writtenFiles.length} files.`);
  } catch (error) {
    s.stop("File generation failed.");
    throw error;
  }
}
