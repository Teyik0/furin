import MagicString from "magic-string";
import { parseSync } from "oxc-parser";

// ---------------------------------------------------------------------------
// Bun.Transpiler singleton — strips TypeScript + JSX before AST work.
// Force classic JSX transform (React.createElement) regardless of the
// project tsconfig's "jsx": "react-jsx" setting — the Bun.build() step
// that consumes this output handles the automatic runtime itself.
// ---------------------------------------------------------------------------
const bunTranspiler = new Bun.Transpiler({
  loader: "tsx",
  tsconfig: {
    compilerOptions: {
      jsx: "react",
      jsxFactory: "React.createElement",
      jsxFragmentFactory: "React.Fragment",
    },
  },
});

// loader: data fetching (runs on server only)
// query / params: Elysia TypeBox schemas — validated server-side, not used in browser
const SERVER_ONLY_PROPERTIES = new Set(["loader", "query", "params", "staticParams"]);

interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  removedServerCode: boolean;
}

// ---------------------------------------------------------------------------
// ESTree node types (minimal subset needed for our walk)
// ---------------------------------------------------------------------------
interface AstNode {
  body?: AstNode[];
  end: number;
  start: number;
  type: string;
  [key: string]: unknown;
}

interface Property extends AstNode {
  key: AstNode & { name?: string };
  type: "Property";
}

interface ObjectExpression extends AstNode {
  properties: Property[];
  type: "ObjectExpression";
}

interface CallExpression extends AstNode {
  arguments: AstNode[];
  callee: AstNode & { name?: string; property?: AstNode & { name?: string } };
  type: "CallExpression";
}

interface ImportDeclaration extends AstNode {
  specifiers: Array<AstNode & { local: AstNode & { name: string } }>;
  type: "ImportDeclaration";
}

// ---------------------------------------------------------------------------
// AST walking
// ---------------------------------------------------------------------------
function walk(node: unknown, visitor: (n: AstNode) => void): void {
  if (!node || typeof node !== "object") {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      walk(child, visitor);
    }
    return;
  }
  const n = node as AstNode;
  if (typeof n.type === "string") {
    visitor(n);
  }
  for (const key of Object.keys(n)) {
    if (key === "type" || key === "start" || key === "end") {
      continue;
    }
    walk(n[key], visitor);
  }
}

// ---------------------------------------------------------------------------
// Check if a CallExpression is createRoute() or page() / route.page()
// ---------------------------------------------------------------------------
function isCreateRouteCall(node: CallExpression): boolean {
  return node.callee.type === "Identifier" && node.callee.name === "createRoute";
}

function isRoutePageCall(node: CallExpression): boolean {
  const { callee } = node;
  if (callee.type === "Identifier" && callee.name === "page") {
    return true;
  }
  if (callee.type === "MemberExpression" && callee.property?.name === "page") {
    return true;
  }
  return false;
}

function isTargetCall(node: CallExpression): boolean {
  return isCreateRouteCall(node) || isRoutePageCall(node);
}

// ---------------------------------------------------------------------------
// Remove server-only properties from an ObjectExpression using MagicString.
// Returns true if any property was removed.
// ---------------------------------------------------------------------------
function removeServerProperties(s: MagicString, source: string, obj: ObjectExpression): boolean {
  const toRemove = obj.properties.filter(
    (p) => p.key.type === "Identifier" && p.key.name && SERVER_ONLY_PROPERTIES.has(p.key.name)
  );
  if (toRemove.length === 0) {
    return false;
  }

  for (const prop of toRemove) {
    // Find the range to remove including the trailing comma + whitespace.
    let removeEnd = prop.end;
    // Skip comma and whitespace after the property
    while (
      removeEnd < source.length &&
      (source[removeEnd] === "," ||
        source[removeEnd] === " " ||
        source[removeEnd] === "\n" ||
        source[removeEnd] === "\r" ||
        source[removeEnd] === "\t")
    ) {
      if (source[removeEnd] === ",") {
        removeEnd++;
        break;
      }
      removeEnd++;
    }

    // Also remove leading whitespace (indentation before the property)
    let removeStart = prop.start;
    while (
      removeStart > 0 &&
      (source[removeStart - 1] === " " || source[removeStart - 1] === "\t")
    ) {
      removeStart--;
    }
    // If there's a newline before the leading whitespace, consume it too
    if (removeStart > 0 && source[removeStart - 1] === "\n") {
      removeStart--;
      if (removeStart > 0 && source[removeStart - 1] === "\r") {
        removeStart--;
      }
    }

    s.remove(removeStart, removeEnd);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Collect all Identifier names referenced in the AST (excluding imports)
// ---------------------------------------------------------------------------
function collectReferencedNames(program: AstNode): Set<string> {
  const refs = new Set<string>();
  for (const stmt of program.body ?? []) {
    if (stmt.type === "ImportDeclaration") {
      continue;
    }
    walk(stmt, (node) => {
      if (
        node.type === "Identifier" &&
        typeof (node as AstNode & { name: string }).name === "string"
      ) {
        refs.add((node as AstNode & { name: string }).name);
      }
    });
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Import pruning helpers
// ---------------------------------------------------------------------------
function removeEntireImport(s: MagicString, code: string, decl: ImportDeclaration): void {
  let removeEnd = decl.end;
  while (removeEnd < code.length && (code[removeEnd] === "\n" || code[removeEnd] === "\r")) {
    removeEnd++;
  }
  s.remove(decl.start, removeEnd);
}

function removeUnusedSpecifiers(
  s: MagicString,
  code: string,
  decl: ImportDeclaration,
  refs: Set<string>
): void {
  const removedSpecs = decl.specifiers.filter((spec) => !refs.has(spec.local.name));
  for (const spec of removedSpecs) {
    let removeStart = spec.start;
    let removeEnd = spec.end;
    while (removeEnd < code.length && (code[removeEnd] === "," || code[removeEnd] === " ")) {
      removeEnd++;
    }
    if (!code.slice(spec.end, removeEnd).includes(",")) {
      while (removeStart > 0 && (code[removeStart - 1] === " " || code[removeStart - 1] === ",")) {
        removeStart--;
      }
    }
    s.remove(removeStart, removeEnd);
  }
}

// ---------------------------------------------------------------------------
// Dead code elimination: remove import specifiers that are no longer
// referenced after server property removal.
// ---------------------------------------------------------------------------
export function deadCodeElimination(s: MagicString): void {
  const code = s.toString();
  const { program, errors } = parseSync("dce.js", code);
  if (errors.length > 0) {
    return;
  }

  const programNode = program as unknown as AstNode;
  const refs = collectReferencedNames(programNode);

  const body = programNode.body ?? [];
  for (let i = body.length - 1; i >= 0; i--) {
    const stmt = body[i];
    if (!stmt) {
      continue;
    }
    if (stmt.type !== "ImportDeclaration") {
      continue;
    }
    const decl = stmt as unknown as ImportDeclaration;
    if (!decl.specifiers || decl.specifiers.length === 0) {
      continue;
    }

    const usedCount = decl.specifiers.filter((spec) => refs.has(spec.local.name)).length;

    if (usedCount === 0) {
      removeEntireImport(s, code, decl);
    } else if (usedCount < decl.specifiers.length) {
      removeUnusedSpecifiers(s, code, decl, refs);
    }
  }
}

// ---------------------------------------------------------------------------
// Remove server-only properties from createRoute() / page() / route.page()
// calls found anywhere in the AST.
// ---------------------------------------------------------------------------
function removeServerExports(s: MagicString, source: string, program: AstNode): boolean {
  let removedServerCode = false;

  walk(program, (node) => {
    if (node.type !== "CallExpression") {
      return;
    }
    const call = node as unknown as CallExpression;
    if (!isTargetCall(call)) {
      return;
    }
    const arg = call.arguments[0];
    if (!arg || arg.type !== "ObjectExpression") {
      return;
    }
    if (removeServerProperties(s, source, arg as unknown as ObjectExpression)) {
      removedServerCode = true;
    }
  });

  return removedServerCode;
}

export function transformForClient(code: string, filename: string): TransformResult {
  // Pass 1 — Bun.Transpiler: strip TypeScript + JSX → plain JS.
  const plainJs = bunTranspiler.transformSync(code);

  // Pass 2 — oxc-parser: parse plain JS to ESTree AST with span offsets.
  const { program, errors } = parseSync(filename, plainJs);
  if (errors.length > 0) {
    throw new Error(`Failed to parse ${filename}: ${errors[0]?.message}`);
  }

  // Pass 3 — MagicString: surgically remove server-only properties.
  const s = new MagicString(plainJs);
  const removedServerCode = removeServerExports(s, plainJs, program as unknown as AstNode);

  // Pass 4 — DCE: prune imports that are no longer referenced.
  if (removedServerCode) {
    deadCodeElimination(s);
  }

  return {
    code: s.toString(),
    map: s.generateMap({ source: filename, includeContent: true }),
    removedServerCode,
  };
}
