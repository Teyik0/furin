import type { SourceLang } from "yuku-parser";

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

interface MaybeWrappedNode {
  expression?: unknown;
  type: string;
}

const TS_WRAPPER_TYPES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
  "TSNonNullExpression",
  "TSInstantiationExpression",
  "ParenthesizedExpression",
]);

export function unwrapTSExpression<T extends { type: string }>(node: T): T {
  let current: MaybeWrappedNode = node;
  while (
    current &&
    typeof current === "object" &&
    TS_WRAPPER_TYPES.has(current.type) &&
    current.expression &&
    typeof current.expression === "object"
  ) {
    current = current.expression as MaybeWrappedNode;
  }
  return current as T;
}
