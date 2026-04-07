import { ScaffolderError } from "./errors.ts";
import { TEMPLATE_IDS, type TemplateId } from "./pipeline/context.ts";

export interface ParsedArgs {
  help: boolean;
  install: boolean;
  targetDir: string | null;
  template: TemplateId | null;
  version: boolean;
  yes: boolean;
}

type BooleanFlag = "help" | "version" | "yes";

const FLAG_ALIASES: Record<string, BooleanFlag> = {
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

  let skipNext = false;

  for (const [index, arg] of argv.entries()) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const alias = FLAG_ALIASES[arg];
    if (alias) {
      result[alias] = true;
      continue;
    }

    if (arg === "--no-install") {
      result.install = false;
      continue;
    }

    if (arg === "--template" || arg === "-t") {
      result.template = parseTemplateFlagValue(arg, argv[index + 1]);
      skipNext = true;
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

function parseTemplate(value: string | undefined): TemplateId {
  if (TEMPLATE_IDS.includes(value as TemplateId)) {
    return value as TemplateId;
  }
  throw new ScaffolderError(
    `Invalid template "${value ?? ""}". Valid options: ${TEMPLATE_IDS.join(", ")}`
  );
}

function parseTemplateFlagValue(flag: "--template" | "-t", value: string | undefined): TemplateId {
  // Treat a missing token *or* a token that looks like a flag as a missing value
  // so that e.g. `--template --yes` reports "Missing value" rather than
  // "Invalid template '--yes'", and --yes is not silently consumed.
  if (value === undefined || value.startsWith("-")) {
    throw new ScaffolderError(`Missing value for ${flag}`);
  }

  return parseTemplate(value);
}
