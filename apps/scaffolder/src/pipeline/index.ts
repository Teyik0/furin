import type { PipelineContext } from "./context.ts";
import { stage1Analysis } from "./stages/1-analysis.ts";
import { stage2Selection } from "./stages/2-selection.ts";
import { stage3Design } from "./stages/3-design.ts";
import { stage4Deps } from "./stages/4-deps.ts";
import { stage5Generation } from "./stages/5-generation.ts";
import { stage6Validation } from "./stages/6-validation.ts";
import { stage7Refinement } from "./stages/7-refinement.ts";

/**
 * Runs the 7-stage scaffolding pipeline.
 * Each stage mutates the shared PipelineContext.
 */
export async function runPipeline(ctx: PipelineContext): Promise<void> {
  await stage1Analysis(ctx);
  await stage2Selection(ctx);
  await stage3Design(ctx);
  await stage4Deps(ctx);
  await stage5Generation(ctx);
  await stage6Validation(ctx);
  await stage7Refinement(ctx);
}
