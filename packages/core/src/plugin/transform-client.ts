import MagicString from "magic-string";
import { walk } from "yuku-ast";
import type { ImportDeclaration, Program } from "yuku-parser";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";
import { hasShadowingDeclaration } from "./binding-scope.ts";
import { deadCodeElimination } from "./dead-code-elimination.ts";
import { transformIsomorphicFunctions } from "./transform-isomorphic.ts";

const FURIN_CLIENT_MODULES = new Set(["@teyik0/furin/client", "furin/client"]);
const FURIN_SERVER_MODULES = new Set(["@teyik0/furin", "furin"]);
const SERVER_ONLY_METHODS = new Set(["config", "head", "loader", "requestLoader", "staticParams"]);

interface TransformResult {
  code: string;
  map: ReturnType<MagicString["generateMap"]> | null;
  removedServerCode: boolean;
}

function isFurinRouteModule(source: unknown): source is string {
  return (
    typeof source === "string" &&
    (FURIN_SERVER_MODULES.has(source) || FURIN_CLIENT_MODULES.has(source))
  );
}

function importedName(specifier: AstNode): string | null {
  const { imported } = specifier;
  if (!imported || typeof imported !== "object") {
    return null;
  }
  const node = imported as AstNode;
  if (node.type === "Identifier" && typeof node.name === "string") {
    return node.name;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  return null;
}

function localName(specifier: AstNode): string | null {
  const { local } = specifier;
  if (!local || typeof local !== "object") {
    return null;
  }
  const node = local as AstNode;
  return node.type === "Identifier" && typeof node.name === "string" ? node.name : null;
}

function collectDefineRouteBindings(program: Program): Set<string> {
  const bindings = new Set<string>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    if (declaration.importKind === "type") {
      continue;
    }
    const source = declaration.source.value;
    if (!isFurinRouteModule(source)) {
      continue;
    }
    for (const specifier of declaration.specifiers as unknown as AstNode[]) {
      if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") {
        continue;
      }
      const imported = importedName(specifier);
      if (imported !== "defineRoute" && imported !== "defineRootRoute") {
        continue;
      }
      const local = localName(specifier);
      if (local) {
        bindings.add(local);
      }
    }
  }
  return bindings;
}

function rewriteDefineRouteImports(
  source: MagicString,
  program: Program,
  bindings: Set<string>
): boolean {
  let rewritten = false;
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement as unknown as ImportDeclaration;
    const moduleName = declaration.source.value;
    if (typeof moduleName !== "string" || !FURIN_SERVER_MODULES.has(moduleName)) {
      continue;
    }
    const importsDefineRoute = (declaration.specifiers as unknown as AstNode[]).some(
      (specifier) => {
        const local = localName(specifier);
        return local !== null && bindings.has(local);
      }
    );
    if (!importsDefineRoute) {
      continue;
    }
    const clientModule = moduleName === "furin" ? "furin/client" : "@teyik0/furin/client";
    source.update(declaration.source.start + 1, declaration.source.end - 1, clientModule);
    rewritten = true;
  }
  return rewritten;
}

function asAstNode(node: unknown): AstNode | null {
  if (!node || typeof node !== "object" || !("type" in node)) {
    return null;
  }
  return unwrapTSExpression(node as { type: string }) as AstNode;
}

function chainRootIsDefineRoute(
  node: unknown,
  bindings: Set<string>,
  ancestors: AstNode[]
): boolean {
  let current = asAstNode(node);
  while (current) {
    if (current.type === "MemberExpression") {
      current = asAstNode(current.object);
      continue;
    }
    if (current.type === "CallExpression") {
      current = asAstNode(current.callee);
      continue;
    }
    return (
      current.type === "Identifier" &&
      typeof current.name === "string" &&
      bindings.has(current.name) &&
      !hasShadowingDeclaration(current.name, ancestors)
    );
  }
  return false;
}

function removeChainedServerCalls(
  source: MagicString,
  program: Program,
  bindings: Set<string>
): boolean {
  let transformed = rewriteDefineRouteImports(source, program, bindings);

  walk(program, {
    CallExpression(call, context) {
      const callee = asAstNode(call.callee);
      if (
        callee?.type !== "MemberExpression" ||
        callee.computed === true ||
        !callee.property ||
        typeof callee.property !== "object"
      ) {
        return;
      }
      const property = callee.property as AstNode;
      if (
        property.type !== "Identifier" ||
        typeof property.name !== "string" ||
        !SERVER_ONLY_METHODS.has(property.name) ||
        !chainRootIsDefineRoute(callee.object, bindings, context.ancestors() as AstNode[])
      ) {
        return;
      }
      const object = asAstNode(callee.object);
      if (!object) {
        return;
      }
      source.remove(object.end, call.end);
      transformed = true;
    },
  });
  return transformed;
}

export function transformForClient(code: string, filename: string): TransformResult {
  const lang = detectLangFromPath(filename);
  if (lang === "dts") {
    return { code, map: null, removedServerCode: false };
  }

  const isomorphicResult = transformIsomorphicFunctions(code, filename, "client");
  const clientSource = isomorphicResult.code;
  const { diagnostics, program } = parseSource(clientSource, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    throw new Error(`Failed to parse ${filename}: ${firstError.message}`);
  }

  let source = new MagicString(clientSource);
  const routeBindings = collectDefineRouteBindings(program);
  const removedRouteCode = removeChainedServerCalls(source, program, routeBindings);
  const removedServerCode = isomorphicResult.transformed || removedRouteCode;
  if (removedServerCode) {
    source = deadCodeElimination(source, code, lang);
  }
  if (routeBindings.size > 0) {
    source.append(`
if (import.meta.hot) {
  import.meta.hot.accept((updatedModule) => {
    const updatedRoute = updatedModule?.route;
    if (updatedRoute?.component) {
      window.__FURIN_HMR_UPDATE__?.(${JSON.stringify(filename)}, updatedRoute.component);
    }
  });
}
`);
  }

  return {
    code: source.toString(),
    map: source.generateMap({ includeContent: true, source: filename }),
    removedServerCode,
  };
}
