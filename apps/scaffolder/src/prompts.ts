import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { templates } from "./template-registry.ts";

export interface PromptResult {
  targetDir: string;
  template: "minimal" | "shadcn";
}

export async function promptForMissingValues(options: {
  targetDir: string | null;
  template: "minimal" | "shadcn" | null;
}): Promise<PromptResult> {
  const rl = createInterface({ input, output });

  try {
    const targetDir =
      options.targetDir ??
      (
        await rl.question("Where should the project be created? ", {
          signal: AbortSignal.timeout(60_000),
        })
      ).trim();

    let template = options.template;

    if (template === null) {
      const answer = await rl.question(
        `Select a template (${templates.map((entry) => entry.id).join("/")}) [minimal]: `,
        { signal: AbortSignal.timeout(60_000) }
      );

      template = answer.trim() === "" ? "minimal" : (answer.trim() as "minimal" | "shadcn");
    }

    return {
      targetDir,
      template,
    };
  } finally {
    rl.close();
  }
}
