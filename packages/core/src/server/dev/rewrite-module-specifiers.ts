import { dirname, resolve } from "node:path";
import MagicString from "magic-string";
import type { Node, StringLiteral } from "yuku-parser";
import { parseSource } from "../../shared/parser.ts";
import { walkAST } from "../../shared/utils/ast-walk.ts";
import { detectLangFromPath, SCRIPT_FILE_FILTER } from "../lang-detect.ts";
import { routeModuleSourceVersion } from "../router/source-version.ts";

interface RewriteModuleSpecifiersInput {
  code: string;
  filePath: string;
  versioned: boolean;
}

function sourcePosition(source: string, byteOffset: number): { column: number; line: number } {
  const bytes = new TextEncoder().encode(source);
  const prefix = new TextDecoder().decode(bytes.slice(0, byteOffset));
  const lines = prefix.split("\n");
  return {
    column: (lines.at(-1)?.length ?? 0) + 1,
    line: lines.length,
  };
}

function isStringLiteral(node: Node | null): node is StringLiteral {
  return node?.type === "Literal" && typeof node.value === "string";
}

function relativeSpecifier(node: Node): StringLiteral | undefined {
  if (
    node.type !== "ExportAllDeclaration" &&
    node.type !== "ExportNamedDeclaration" &&
    node.type !== "ImportDeclaration" &&
    node.type !== "ImportExpression"
  ) {
    return;
  }
  return isStringLiteral(node.source) ? node.source : undefined;
}

function resolvedSpecifier(specifier: string, directory: string, versioned: boolean): string {
  const path = versioned ? Bun.resolveSync(specifier, directory) : resolve(directory, specifier);
  const normalized = path.replaceAll("\\", "/");
  return versioned && SCRIPT_FILE_FILTER.test(normalized)
    ? `${normalized}?furin-server&t=${routeModuleSourceVersion(normalized)}`
    : normalized;
}

export function rewriteModuleSpecifiers(input: RewriteModuleSpecifiersInput): string {
  const { diagnostics, program } = parseSource(input.code, detectLangFromPath(input.filePath));
  const parseError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (parseError) {
    const error = new Error(`Failed to parse ${input.filePath}: ${parseError.message}`);
    Reflect.set(error, "position", sourcePosition(input.code, parseError.start));
    throw error;
  }

  const directory = dirname(input.filePath);
  const output = new MagicString(input.code);
  walkAST(program, (node) => {
    const literal = relativeSpecifier(node);
    const specifier = literal?.value;
    if (
      !literal ||
      typeof specifier !== "string" ||
      !(specifier.startsWith("./") || specifier.startsWith("../"))
    ) {
      return;
    }
    output.update(
      literal.start,
      literal.end,
      JSON.stringify(resolvedSpecifier(specifier, directory, input.versioned))
    );
  });
  return output.toString();
}
