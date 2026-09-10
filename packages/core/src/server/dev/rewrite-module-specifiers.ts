import { dirname, resolve } from "node:path";
import MagicString from "magic-string";
import { parseSource } from "../../shared/parser.ts";
import type { AstNode } from "../../shared/utils/ast-walk.ts";
import { walkAST } from "../../shared/utils/ast-walk.ts";
import { detectLangFromPath } from "../lang-detect.ts";
import { routeModuleSourceVersion } from "../router/source-version.ts";

interface RewriteModuleSpecifiersInput {
  code: string;
  filePath: string;
  versioned: boolean;
}

const SCRIPT_PATH_RE = /\.[cm]?[jt]sx?$/;
const MODULE_SPECIFIER_NODES = new Set([
  "ExportAllDeclaration",
  "ExportNamedDeclaration",
  "ImportDeclaration",
  "ImportExpression",
]);

function sourcePosition(source: string, byteOffset: number): { column: number; line: number } {
  const bytes = new TextEncoder().encode(source);
  const prefix = new TextDecoder().decode(bytes.slice(0, byteOffset));
  const lines = prefix.split("\n");
  return {
    column: (lines.at(-1)?.length ?? 0) + 1,
    line: lines.length,
  };
}

function relativeSpecifier(node: AstNode): AstNode | undefined {
  if (!MODULE_SPECIFIER_NODES.has(node.type)) {
    return;
  }
  const { source } = node;
  if (!source || typeof source !== "object") {
    return;
  }
  const literal = source as AstNode;
  return literal.type === "Literal" && typeof literal.value === "string" ? literal : undefined;
}

function resolvedSpecifier(specifier: string, directory: string, versioned: boolean): string {
  const path = versioned ? Bun.resolveSync(specifier, directory) : resolve(directory, specifier);
  const normalized = path.replaceAll("\\", "/");
  return versioned && SCRIPT_PATH_RE.test(normalized)
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
