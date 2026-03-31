import { ScaffolderError } from "./errors.ts";

export interface ParsedArgs {
  help: boolean;
  targetDir: string | null;
  template: "minimal" | "shadcn" | null;
  version: boolean;
  yes: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
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

    if (isHelpFlag(arg)) {
      result.help = true;
      continue;
    }

    if (isVersionFlag(arg)) {
      result.version = true;
      continue;
    }

    if (isYesFlag(arg)) {
      result.yes = true;
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

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function isVersionFlag(value: string): boolean {
  return value === "--version" || value === "-v";
}

function isYesFlag(value: string): boolean {
  return value === "--yes" || value === "-y";
}

function parseTemplate(value: string | undefined): "minimal" | "shadcn" {
  if (value === "minimal" || value === "shadcn") {
    return value;
  }

  throw new ScaffolderError(`Invalid template "${value ?? ""}". Use "minimal" or "shadcn"`);
}
