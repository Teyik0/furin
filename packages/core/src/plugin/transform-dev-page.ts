import MagicString from "magic-string";
import type { Node, Program, ProgramStatement } from "yuku-parser";
import {
  detectLangFromPath,
  detectLoaderFromPath,
  unwrapTSExpression,
} from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { walkAST } from "../shared/utils/ast-walk.ts";
import { deadCodeElimination } from "./dead-code-elimination.ts";
import { collectDefineRouteBindings, exportedRouteChain } from "./route-chains.ts";

interface SplitDevPage {
  contract: string;
  render: string;
}

function node(value: Node | null | undefined): Node | undefined {
  if (value) {
    return unwrapTSExpression(value);
  }
}

function namesIn(value: Node | null | undefined): Set<string> {
  const names = new Set<string>();
  walkAST(value, (entry) => {
    if (entry.type === "Identifier" || entry.type === "JSXIdentifier") {
      names.add(entry.name);
    }
  });
  return names;
}

function bindingPatterns(entry: Node): (Node | null)[] {
  switch (entry.type) {
    case "ArrowFunctionExpression":
    case "FunctionDeclaration":
    case "FunctionExpression":
      return [entry.id, ...entry.params];
    case "CatchClause":
      return [entry.param];
    case "ClassDeclaration":
    case "ClassExpression":
    case "VariableDeclarator":
      return [entry.id];
    default:
      return [];
  }
}

function callbackBindings(callback: Node): Set<string> {
  const bindings = new Set<string>();
  walkAST(callback, (entry) => {
    for (const pattern of bindingPatterns(entry)) {
      for (const name of namesIn(pattern)) {
        bindings.add(name);
      }
    }
  });
  return bindings;
}

function exportedDeclaration(statement: ProgramStatement): Node | undefined {
  if (
    statement.type === "ExportNamedDeclaration" ||
    statement.type === "ExportDefaultDeclaration"
  ) {
    return node(statement.declaration);
  }
  return statement.type === "ExportAllDeclaration" ? undefined : statement;
}

function inspectModule(statements: ProgramStatement[]) {
  const imports = statements.filter((statement) => statement.type === "ImportDeclaration");
  let localBindings = new Set<string>();
  for (const statement of statements) {
    const declaration = exportedDeclaration(statement);
    if (declaration?.type === "VariableDeclaration") {
      for (const binding of declaration.declarations) {
        localBindings = localBindings.union(namesIn(binding.id));
      }
    } else if (declaration) {
      localBindings = localBindings.union(
        namesIn("id" in declaration ? declaration.id : undefined)
      );
    }
  }
  return { imports, localBindings };
}

/** The inline callback of the exported route's `.page()` terminal. */
function inlinePage(program: Program): Node | undefined {
  const [terminal] = exportedRouteChain(program, collectDefineRouteBindings(program))?.calls ?? [];
  const args = terminal?.call.arguments ?? [];
  const callback = node(args[0]);
  if (
    terminal?.method === "page" &&
    args.length === 1 &&
    (callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression")
  ) {
    return callback;
  }
}

function hasLexicalCapture(callback: Node, program: Program): boolean {
  let opaque = false;
  walkAST(program, (entry) => {
    if (
      (entry.type === "VariableDeclaration" && entry.kind === "var") ||
      (entry.type === "Identifier" && entry.name === "eval")
    ) {
      opaque = true;
    }
    if (entry.start < callback.start || entry.end > callback.end) {
      return;
    }
    if (
      entry.type === "ThisExpression" ||
      entry.type === "MetaProperty" ||
      (entry.type === "Identifier" && (entry.name === "eval" || entry.name === "arguments"))
    ) {
      opaque = true;
    }
  });
  return opaque;
}

function routeHasConsumers(statements: ProgramStatement[]): boolean {
  let references = 0;
  for (const statement of statements) {
    if (statement.type === "ImportDeclaration") {
      continue;
    }
    walkAST(statement, (entry) => {
      if (
        (entry.type === "Identifier" || entry.type === "JSXIdentifier") &&
        entry.name === "route"
      ) {
        references += 1;
      }
    });
  }
  return references !== 1; // The declaration itself accounts for one reference.
}

/** Split only a top-level route with an inline page that captures imports, not module state. */
export function splitDevPage(
  source: string,
  filePath: string,
  renderSpecifier: string
): SplitDevPage | undefined {
  if (!source.includes(".page") || source.includes("@jsx")) {
    return;
  }
  const lang = detectLangFromPath(filePath);
  const { program, diagnostics } = parseSource(source, lang);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return;
  }
  const statements = program.body;
  if (routeHasConsumers(statements)) {
    return;
  }
  const { imports, localBindings } = inspectModule(statements);
  const callback = inlinePage(program);
  if (!callback || hasLexicalCapture(callback, program)) {
    return;
  }
  const shadowed = callbackBindings(callback);
  if (
    imports.some((entry) =>
      entry.specifiers.some((specifier) => shadowed.has(specifier.local.name))
    )
  ) {
    return;
  }
  const references = namesIn(callback);
  const bindings = localBindings.union(
    new Set(imports.flatMap((entry) => entry.specifiers.map((specifier) => specifier.local.name)))
  );
  if (
    [...localBindings].some((name) => references.has(name)) ||
    ["__furinDeferredRender", "Object", "Symbol", "Error"].some((name) => bindings.has(name))
  ) {
    return;
  }
  const renderImports = imports.filter((entry) =>
    entry.specifiers.some((specifier) => references.has(specifier.local.name))
  );
  const rewritten = new MagicString(source);
  rewritten.overwrite(callback.start, callback.end, "__furinDeferredRender");
  const contract = deadCodeElimination(rewritten, source, lang).toString();
  // Splitting without removing an import cannot avoid loading any dependency.
  const scanner = new Bun.Transpiler({ loader: detectLoaderFromPath(filePath) });
  const retained = new Set(scanner.scanImports(contract).map((entry) => entry.path));
  if (!renderImports.some((entry) => !retained.has(entry.source.value))) {
    return;
  }
  const fragment = `${renderImports.map((entry) => source.slice(entry.start, entry.end)).join("\n")}\nexport default ${source.slice(callback.start, callback.end)};`;
  return {
    contract: `const __furinDeferredRender = Object.assign(() => { throw new Error("Unresolved Furin page"); }, { [Symbol.for("furin.dev.render")]: () => import(${JSON.stringify(renderSpecifier)}) });\n${contract}`,
    render: deadCodeElimination(new MagicString(fragment), source, lang).toString(),
  };
}
