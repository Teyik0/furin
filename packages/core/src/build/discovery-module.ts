import { pruneOrphanedCode } from "../plugin/dead-code-elimination.ts";
import { parseModule, replaceRange } from "../plugin/module-transform.ts";
import { collectDefineRouteBindings, exportedRouteChain } from "../plugin/route-chains.ts";

/** Stub route behavior while preserving module initialization and public metadata. */
export function discoveryModule(
  code: string,
  path: string,
  loader: "js" | "jsx" | "ts" | "tsx"
): string {
  const module = parseModule(code, `${path}.${loader}`);
  const chain = exportedRouteChain(module.program, collectDefineRouteBindings(module.program));
  const boundary = /[\\/](?:error|not-found)\.[jt]sx?$/.test(path);
  if (!(chain || boundary)) {
    return code;
  }
  for (const { call, method } of chain?.calls ?? []) {
    if (method === "config") {
      continue;
    }
    for (const argument of call.arguments) {
      replaceRange(module, argument.start, argument.end, "() => undefined");
    }
  }
  if (boundary) {
    for (const statement of module.program.body) {
      if (statement.type !== "ExportDefaultDeclaration") {
        continue;
      }
      const declaration = statement.declaration;
      if (declaration.type === "FunctionDeclaration" && declaration.body) {
        replaceRange(module, declaration.body.start, declaration.body.end, "{ return null; }");
      } else if (declaration.type === "ClassDeclaration") {
        for (const member of declaration.body.body) {
          if (
            (member.type === "MethodDefinition" || member.type === "PropertyDefinition") &&
            !member.static &&
            ((member.key.type === "Identifier" && member.key.name === "render") ||
              (member.key.type === "Literal" && member.key.value === "render"))
          ) {
            const render = member.value;
            if (
              (render?.type === "FunctionExpression" ||
                render?.type === "ArrowFunctionExpression") &&
              render.body
            ) {
              replaceRange(
                module,
                render.body.start,
                render.body.end,
                render.body.type === "BlockStatement" ? "{ return null; }" : "null"
              );
            }
          }
        }
      } else {
        replaceRange(module, declaration.start, declaration.end, "() => null");
      }
    }
  }
  pruneOrphanedCode(module, new Set(), new Set());
  return module.source.toString();
}

export function discoveryModuleFilter(pagesDirs: readonly string[]): RegExp {
  const directories = pagesDirs
    .map((path) => path.split(/[\\/]/).map(RegExp.escape).join("[\\\\/]"))
    .join("|");
  return new RegExp(`^(?:${directories})[\\\\/].*\\.[cm]?[jt]sx?$`);
}
