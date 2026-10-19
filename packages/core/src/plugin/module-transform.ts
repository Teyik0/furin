import MagicString from "magic-string";
import type { Program } from "yuku-parser";
import { detectLangFromPath } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";

export interface SourceRange {
  end: number;
  start: number;
}

/**
 * One module through one transform pass. It is parsed once: every step reads
 * `program`, the AST of `code`, and writes its edits to `source` in `code`
 * coordinates. A step that drops code records the range in `removed`, so the
 * next steps analyse the edited module without reparsing it.
 */
export interface ModuleTransform {
  code: string;
  filename: string;
  program: Program;
  removed: SourceRange[];
  source: MagicString;
}

export function parseModule(code: string, filename: string): ModuleTransform {
  const { diagnostics, program } = parseSource(code, detectLangFromPath(filename));
  const error = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (error) {
    throw new Error(`Failed to parse ${filename}: ${error.message}`);
  }
  return { code, filename, program, removed: [], source: new MagicString(code) };
}

export function isRemoved(node: SourceRange, removed: readonly SourceRange[]): boolean {
  return removed.some((range) => range.start <= node.start && node.end <= range.end);
}

export type EditedModule = Pick<ModuleTransform, "removed" | "source">;

/**
 * Replaces a range of the original code and records it as removed. The range's
 * line breaks follow `content`: Bun ignores the sourcemaps of `onLoad` results,
 * so stack traces only match the source if every surviving line stays in place.
 */
export function replaceRange(
  module: EditedModule,
  start: number,
  end: number,
  content: string
): void {
  const replacement =
    content + "\n".repeat(module.source.original.slice(start, end).split("\n").length - 1);
  if (replacement === "") {
    module.source.remove(start, end);
  } else {
    module.source.overwrite(start, end, replacement);
  }
  module.removed.push({ end, start });
}

export function removeRange(module: EditedModule, start: number, end: number): void {
  replaceRange(module, start, end, "");
}
