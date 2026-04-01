import pkg from "../package.json";
import { parseArgs } from "./args.ts";
import { ScaffolderError } from "./errors.ts";
import { promptForMissingValues } from "./prompts.ts";
import { createProject } from "./scaffold.ts";

export async function run(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);

    if (args.help) {
      printHelp();
      return 0;
    }

    if (args.version) {
      console.log(pkg.version);
      return 0;
    }

    assertBunRuntime();

    const resolved =
      args.targetDir === null
        ? await promptForMissingValues({ targetDir: args.targetDir, template: args.template })
        : { targetDir: args.targetDir, template: args.template ?? "minimal" };

    const result = await createProject({
      install: args.install,
      targetDir: resolved.targetDir,
      template: resolved.template,
      yes: args.yes,
    });

    console.log(`Created ${resolved.template} app in ${result.targetDir}`);
    console.log("Next steps:");
    console.log(`  cd ${resolved.targetDir}`);
    console.log("  bun run dev");
    return 0;
  } catch (error) {
    if (error instanceof ScaffolderError) {
      console.error(`Error: ${error.message}`);
      return 1;
    }

    console.error(error);
    return 1;
  }
}

function assertBunRuntime(): void {
  if (typeof Bun === "undefined") {
    throw new ScaffolderError("create-furin requires Bun");
  }
}

function printHelp(): void {
  console.log(`create-furin

Usage:
  bun create furin <dir>
  bun create furin <dir> --template shadcn
  bunx create-furin <dir>

Options:
  --template <minimal|shadcn>
  --yes
  --no-install
  --help
  --version`);
}
