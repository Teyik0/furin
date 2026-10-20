import type { Expression, Node, NodeOfType, NodeType, SourceLang } from "yuku-parser";

export const SCRIPT_FILE_FILTER = /\.(?:[cm]?[jt]s|[jt]sx)(?:\?.*)?$/;
const DECLARATION_FILE_RE = /\.d\.[cm]?ts$/;
const TYPESCRIPT_FILE_RE = /\.[cm]?ts$/;

export function detectLangFromPath(filePath: string): SourceLang {
  const path = filePath.split("?")[0] as string;
  if (DECLARATION_FILE_RE.test(path)) {
    return "dts";
  }
  if (path.endsWith(".tsx")) {
    return "tsx";
  }
  if (TYPESCRIPT_FILE_RE.test(path)) {
    return "ts";
  }
  if (path.endsWith(".jsx")) {
    return "jsx";
  }
  return "js";
}

export function detectLoaderFromPath(filePath: string): "js" | "jsx" | "ts" | "tsx" {
  const lang = detectLangFromPath(filePath);
  return lang === "dts" ? "ts" : lang;
}

const TS_WRAPPER_TYPES = new Set<NodeType>([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

type TSWrapper = NodeOfType<
  | "TSAsExpression"
  | "TSSatisfiesExpression"
  | "TSTypeAssertion"
  | "TSNonNullExpression"
  | "TSInstantiationExpression"
  | "ParenthesizedExpression"
>;

function isTSWrapper(node: Node): node is TSWrapper {
  return TS_WRAPPER_TYPES.has(node.type);
}

export function unwrapTSExpression(node: Expression): Expression;
export function unwrapTSExpression(node: Node): Node;
export function unwrapTSExpression(node: Node): Node {
  let current = node;
  while (isTSWrapper(current)) {
    current = current.expression;
  }
  return current;
}
