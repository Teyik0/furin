import { intro, outro } from "@clack/prompts";
import pc from "picocolors";
import type { ParsedArgs } from "./args.ts";
import { createContext } from "./pipeline/context.ts";
import { runPipeline } from "./pipeline/index.ts";

export async function run(args: ParsedArgs): Promise<void> {
  intro(pc.bgCyan(pc.black(" create-furin ")));

  const ctx = createContext({
    projectName: args.targetDir ?? "",
    templateId: args.template,
    install: args.install,
    yes: args.yes,
  });

  await runPipeline(ctx);

  outro(
    [
      pc.green("Project created!"),
      "",
      pc.dim("Next steps:"),
      `  ${pc.cyan(`cd ${ctx.projectNameKebab}`)}`,
      `  ${pc.cyan("bun dev")}`,
    ].join("\n")
  );
}
