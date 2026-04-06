import { note } from "@clack/prompts";
import { generateFileTree } from "../../utils/tree-view.ts";
import type { GeneratedFile, PipelineContext } from "../context.ts";
import { resolveTemplateSrc } from "../context.ts";

export function stage3Design(ctx: PipelineContext): void {
  if (!ctx.manifest) {
    throw new Error("Manifest not loaded — stage2Selection must run first.");
  }

  // ── Build ordered GeneratedFile list from manifest ─────────────────────
  ctx.fileTree = ctx.manifest.files.map(
    (f): GeneratedFile => ({
      relativePath: f.dest,
      kind: f.kind,
      sourcePath: resolveTemplateSrc(f.src),
    })
  );

  // ── Build ASCII tree for the preview (strip .ejs from display names) ───
  const displayPaths = ctx.fileTree.map((f) => f.relativePath);
  ctx.treePreviewLines = generateFileTree(ctx.projectNameKebab, displayPaths);

  // ── Show the preview to the user ───────────────────────────────────────
  note(ctx.treePreviewLines.join("\n"), "Your project will include:");
}
