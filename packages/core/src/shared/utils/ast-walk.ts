import type { Node } from "yuku-parser";

const SKIP_KEYS = new Set(["type", "start", "end", "comments"]);

export function isNode(value: object): value is Node {
  return "type" in value && typeof value.type === "string";
}

/**
 * Walks an ESTree-compatible AST node recursively, calling `visitor` for every
 * node that has a `type` property.
 *
 * Arrays are traversed element-by-element.  The keys `type`, `start` and `end`
 * are skipped so that the visitor is only invoked on genuine child nodes.
 */
export function walkAST(node: unknown, visitor: (n: Node) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walkAST(child, visitor);
    }
    return;
  }
  if (!isNode(node)) {
    return;
  }
  visitor(node);
  for (const [key, child] of Object.entries(node)) {
    if (!SKIP_KEYS.has(key)) {
      walkAST(child, visitor);
    }
  }
}
