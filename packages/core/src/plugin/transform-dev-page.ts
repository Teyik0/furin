import MagicString from "magic-string";
import {
  detectLangFromPath,
  detectLoaderFromPath,
  unwrapTSExpression,
} from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { type AstNode, walkAST } from "../shared/utils/ast-walk.ts";
import { FactoryBindings } from "./binding-scope.ts";
import { deadCodeElimination } from "./dead-code-elimination.ts";

interface SplitDevPage {
  contract: string;
  render: string;
}

function node(value: unknown): AstNode | undefined {
  if (value && typeof value === "object" && "type" in value) {
    return unwrapTSExpression(value as AstNode) as AstNode;
  }
}

function namesIn(value: unknown): Set<string> {
  const names = new Set<string>();
  walkAST(value, (entry) => {
    if (
      (entry.type === "Identifier" || entry.type === "JSXIdentifier") &&
      typeof entry.name === "string"
    ) {
      names.add(entry.name);
    }
  });
  return names;
}

const CALLBACK_BINDING_TYPES = new Set([
  "ArrowFunctionExpression",
  "CatchClause",
  "ClassDeclaration",
  "ClassExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "VariableDeclarator",
]);

function callbackBindings(callback: AstNode): Set<string> {
  const bindings = new Set<string>();
  walkAST(callback, (entry) => {
    if (!CALLBACK_BINDING_TYPES.has(entry.type)) {
      return;
    }
    const patterns = [entry.id, entry.param, ...(Array.isArray(entry.params) ? entry.params : [])];
    for (const pattern of patterns) {
      for (const name of namesIn(pattern)) {
        bindings.add(name);
      }
    }
  });
  return bindings;
}

function defineRouteBindings(imports: AstNode[]): Set<string> {
  const bindings = new Set<string>();
  for (const declaration of imports) {
    const specifier = node(declaration.source)?.value;
    if (specifier !== "furin" && specifier !== "@teyik0/furin") {
      continue;
    }
    for (const entry of declaration.specifiers as AstNode[]) {
      const local = node(entry.local)?.name;
      if (node(entry.imported)?.name === "defineRoute" && typeof local === "string") {
        bindings.add(local);
      }
    }
  }
  return bindings;
}

function inspectModule(statements: AstNode[]) {
  const imports = statements.filter((statement) => statement.type === "ImportDeclaration");
  let localBindings = new Set<string>();
  let terminal: AstNode | undefined;
  for (const statement of statements) {
    const declaration = statement.type.startsWith("Export")
      ? node(statement.declaration)
      : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const binding of declaration.declarations as AstNode[]) {
        localBindings = localBindings.union(namesIn(binding.id));
        if (statement.type === "ExportNamedDeclaration" && node(binding.id)?.name === "route") {
          terminal = node(binding.init);
        }
      }
    } else if (declaration) {
      localBindings = localBindings.union(namesIn(declaration.id));
    }
  }
  return { imports, localBindings, terminal };
}

function inlinePage(
  terminal: AstNode | undefined,
  bindings: FactoryBindings,
  ancestors: AstNode[]
): AstNode | undefined {
  const callee = node(terminal?.callee);
  const args = terminal?.arguments as AstNode[] | undefined;
  const callback = node(args?.[0]);
  if (
    terminal?.type !== "CallExpression" ||
    callee?.type !== "MemberExpression" ||
    callee.computed ||
    node(callee.property)?.name !== "page" ||
    args?.length !== 1 ||
    !callback ||
    (callback.type !== "ArrowFunctionExpression" && callback.type !== "FunctionExpression")
  ) {
    return;
  }
  let root = node(callee.object);
  while (root?.type === "CallExpression" || root?.type === "MemberExpression") {
    root = node(root.type === "CallExpression" ? root.callee : root.object);
  }
  if (root && bindings.factoryName(root, ancestors) !== undefined) {
    return callback;
  }
}

function hasLexicalCapture(callback: AstNode, program: unknown): boolean {
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

function routeHasConsumers(statements: AstNode[]): boolean {
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
  const statements = program.body as unknown as AstNode[];
  if (routeHasConsumers(statements)) {
    return;
  }
  const { imports, localBindings, terminal } = inspectModule(statements);
  const factories = new FactoryBindings(program, defineRouteBindings(imports), new Set());
  const callback = inlinePage(terminal, factories, [program as unknown as AstNode]);
  if (!callback || hasLexicalCapture(callback, program)) {
    return;
  }
  const shadowed = callbackBindings(callback);
  if (
    imports.some((entry) =>
      (entry.specifiers as AstNode[]).some((specifier) =>
        shadowed.has(String(node(specifier.local)?.name))
      )
    )
  ) {
    return;
  }
  const references = namesIn(callback);
  const bindings = localBindings.union(
    new Set(
      imports.flatMap((entry) =>
        (entry.specifiers as AstNode[]).map((specifier) => String(node(specifier.local)?.name))
      )
    )
  );
  if (
    [...localBindings].some((name) => references.has(name)) ||
    ["__furinDeferredRender", "Object", "Symbol", "Error"].some((name) => bindings.has(name))
  ) {
    return;
  }
  const renderImports = imports.filter((entry) =>
    (entry.specifiers as AstNode[]).some((specifier) =>
      references.has(String(node(specifier.local)?.name))
    )
  );
  const rewritten = new MagicString(source);
  rewritten.overwrite(callback.start, callback.end, "__furinDeferredRender");
  const contract = deadCodeElimination(rewritten, source, lang).toString();
  // Splitting without removing an import cannot avoid loading any dependency.
  const scanner = new Bun.Transpiler({ loader: detectLoaderFromPath(filePath) });
  const retained = new Set(scanner.scanImports(contract).map((entry) => entry.path));
  if (!renderImports.some((entry) => !retained.has(String(node(entry.source)?.value)))) {
    return;
  }
  const fragment = `${renderImports.map((entry) => source.slice(entry.start, entry.end)).join("\n")}\nexport default ${source.slice(callback.start, callback.end)};`;
  return {
    contract: `const __furinDeferredRender = Object.assign(() => { throw new Error("Unresolved Furin page"); }, { [Symbol.for("furin.dev.render")]: () => import(${JSON.stringify(renderSpecifier)}) });\n${contract}`,
    render: deadCodeElimination(new MagicString(fragment), source, lang).toString(),
  };
}
