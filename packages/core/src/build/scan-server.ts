import { readFileSync } from "node:fs";
import { parseSync } from "oxc-parser";

// Minimal AST node shapes — just what we need
interface AstNode {
  type: string;
  [key: string]: unknown;
}

/**
 * Statically scans a server entry file and returns all `pagesDir` string
 * literal values found inside `furin({ pagesDir: "..." })` call expressions.
 *
 * Dynamic paths (template literals, variables) are silently ignored.
 * Returns an empty array when nothing is detected.
 */
export function scanFurinInstances(serverEntryPath: string): string[] {
  const code = readFileSync(serverEntryPath, "utf8");
  const { program, errors } = parseSync(serverEntryPath, code);
  if (errors.length > 0) {
    return [];
  }

  const results: string[] = [];
  walkNode(program as unknown as AstNode, results);
  return results;
}

const SKIP_KEYS = new Set(["type", "start", "end"]);

/** Checks whether `node` is a `furin({ pagesDir: "..." })` call and, if so, pushes the value. */
function checkFurinCall(node: AstNode, out: string[]): void {
  const callee = node.callee as AstNode | undefined;
  const args = node.arguments as AstNode[] | undefined;
  const isFurinCall =
    callee?.type === "Identifier" && (callee as { name?: string }).name === "furin";

  if (!(isFurinCall && Array.isArray(args)) || args.length === 0) {
    return;
  }

  const firstArg = args[0] as AstNode;
  if (firstArg?.type !== "ObjectExpression") {
    return;
  }

  const pagesDir = extractStringProperty(firstArg, "pagesDir");
  if (pagesDir !== null) {
    out.push(pagesDir);
  }
}

/** Recurses into all child AST node values (arrays and plain objects). */
function walkChildren(node: AstNode, out: string[]): void {
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) {
      continue;
    }
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item === "object") {
          walkNode(item as AstNode, out);
        }
      }
    } else if (child && typeof child === "object") {
      walkNode(child as AstNode, out);
    }
  }
}

function walkNode(node: AstNode, out: string[]): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (node.type === "CallExpression") {
    checkFurinCall(node, out);
  }
  walkChildren(node, out);
}

function extractStringProperty(obj: AstNode, propName: string): string | null {
  const properties = obj.properties as AstNode[] | undefined;
  if (!Array.isArray(properties)) {
    return null;
  }

  for (const prop of properties) {
    if (prop.type !== "Property") {
      continue;
    }
    const key = prop.key as AstNode & { name?: string; value?: unknown };
    const value = prop.value as AstNode & { value?: unknown };

    const keyMatches =
      (key.type === "Identifier" && key.name === propName) ||
      (key.type === "Literal" && key.value === propName);

    if (!keyMatches) {
      continue;
    }

    // Only accept string literals — ignore template literals, identifiers, etc.
    if (value?.type === "Literal" && typeof value.value === "string") {
      return value.value;
    }
    return null; // dynamic path — silently skip
  }
  return null;
}
