import { ScaffolderError } from "./errors.ts";

export interface ParsedArgs {
  help: boolean;
  install: boolean;
  targetDir: string | null;
  template: "minimal" | "shadcn" | null;
  version: boolean;
  yes: boolean;
}

const flagAliases: Record<string, keyof ParsedArgs> = {
  "--help": "help",
  "-h": "help",
  "--version": "version",
  "-v": "version",
  "--yes": "yes",
  "-y": "yes",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
    install: true,
    targetDir: null,
    template: null,
    version: false,
    yes: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (!arg) {
      continue;
    }

    if (flagAliases[arg]) {
      result[flagAliases[arg]] = true as never;
      continue;
    }

    if (arg === "--no-install") {
      result.install = false;
      continue;
    }

    if (arg === "--template") {
      result.template = parseTemplate(argv[index + 1]);
      index += 1;
      continue;
    }

    if (arg.startsWith("--template=")) {
      result.template = parseTemplate(arg.slice("--template=".length));
      continue;
    }

    if (arg.startsWith("-")) {
      throw new ScaffolderError(`Unknown option "${arg}"`);
    }

    if (result.targetDir !== null) {
      throw new ScaffolderError("Only one target directory may be provided");
    }

    result.targetDir = arg;
  }

  if (result.yes && result.targetDir === null) {
    throw new ScaffolderError("Target directory is required when using --yes");
  }

  return result;
}

function parseTemplate(value: string | undefined): "minimal" | "shadcn" {
  if (value === "minimal" || value === "shadcn") {
    return value;
  }

  throw new ScaffolderError(`Invalid template "${value ?? ""}". Use "minimal" or "shadcn"`);
}
