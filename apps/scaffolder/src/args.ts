import { ScaffolderError } from "./errors.ts";
import {
  ROUTE_STYLES,
  type RouteStyle,
  TEMPLATE_IDS,
  type TemplateId,
} from "./pipeline/context.ts";

export interface ParsedArgs {
  help: boolean;
  install: boolean;
  style: RouteStyle | null;
  targetDir: string | null;
  template: TemplateId | null;
  version: boolean;
  yes: boolean;
}

type BooleanFlag = "help" | "version" | "yes";

const FLAG_ALIASES: Record<string, BooleanFlag> = {
  "--help": "help",
  "--version": "version",
  "--yes": "yes",
  "-h": "help",
  "-v": "version",
  "-y": "yes",
};

export function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = {
    help: false,
    install: true,
    style: null,
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

    const valueFlag = parseValueFlag(result, arg, argv[index + 1]);
    if (valueFlag !== "none") {
      skipNext = valueFlag === "next";
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

/**
 * Applies `--template`/`-t`/`--style` (next token) or `--template=`/`--style=`
 * (inline value). Returns whether the flag consumed the next token.
 */
function parseValueFlag(
  result: ParsedArgs,
  arg: string,
  next: string | undefined
): "inline" | "next" | "none" {
  if (arg === "--template" || arg === "-t") {
    result.template = parseTemplateFlagValue(arg, next);
    return "next";
  }
  if (arg.startsWith("--template=")) {
    result.template = parseTemplate(arg.slice("--template=".length));
    return "inline";
  }
  if (arg === "--style") {
    if (next === undefined || next.startsWith("-")) {
      throw new ScaffolderError("Missing value for --style");
    }
    result.style = parseStyle(next);
    return "next";
  }
  if (arg.startsWith("--style=")) {
    result.style = parseStyle(arg.slice("--style=".length));
    return "inline";
  }
  return "none";
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

function parseStyle(value: string): RouteStyle {
  if (ROUTE_STYLES.includes(value as RouteStyle)) {
    return value as RouteStyle;
  }
  throw new ScaffolderError(`Invalid style "${value}". Valid options: ${ROUTE_STYLES.join(", ")}`);
}
