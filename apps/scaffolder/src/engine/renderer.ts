import ejs from "ejs";
import type { EjsTemplateVars, PipelineContext } from "../pipeline/context.ts";

/**
 * Renders an EJS template file with the given variables.
 * Returns the rendered string content.
 */
export async function renderEjsFile(sourcePath: string, vars: EjsTemplateVars): Promise<string> {
  const template = await Bun.file(sourcePath).text();
  return ejs.render(template, vars, {
    async: false,
    strict: false,
  });
}

/**
 * Builds the EJS template variables from the pipeline context.
 * Called during Stage 5 after deps are resolved in Stage 4.
 */
export function buildEjsVars(ctx: PipelineContext): EjsTemplateVars {
  if (!ctx.routeStyle) {
    throw new Error("Routing style not selected — stage2Selection must run first.");
  }
  return {
    features: ctx.features,
    furinVersion: ctx.furinVersion,
    projectName: ctx.projectName,
    projectNameKebab: ctx.projectNameKebab,
    projectNamePascal: ctx.projectNamePascal,
    routeStyle: ctx.routeStyle,
    versions: {
      ...ctx.dependencies,
      ...ctx.devDependencies,
    },
  };
}
