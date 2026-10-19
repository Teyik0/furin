import MagicString from "magic-string";
import type {
  ImportDeclaration,
  Node,
  Program,
  ProgramStatement,
  SourceLang,
  TSAsExpression,
  TSSatisfiesExpression,
  TSTypeAssertion,
  VariableDeclaration,
  VariableDeclarator,
} from "yuku-parser";
import { unwrapTSExpression } from "../server/lang-detect.ts";
import { parseSource } from "../shared/parser.ts";
import { isNode } from "../shared/utils/ast-walk.ts";
import { isRemoved, type ModuleTransform, type SourceRange } from "./module-transform.ts";

const TYPE_SCOPE_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeParameterDeclaration",
  "TSTypeParameterInstantiation",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSTypePredicate",
  "TSClassImplements",
  "TSExpressionWithTypeArguments",
]);
const TYPE_ASSERTION_NODES = new Set([
  "TSAsExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);
const WALK_SKIPPED_KEYS = new Set(["type", "start", "end"]);

/** A top-level statement, or one declarator of a top-level variable declaration. */
interface ModuleUnit {
  /** Variable declaration owning a declarator unit; null for other statements. */
  declaration: VariableDeclaration | null;
  exported: boolean;
  /** Bindings the unit declares and DCE may remove. */
  names: string[];
  node: ProgramStatement | VariableDeclarator;
  references: Set<string>;
}

interface ModuleReferences {
  /** Every identifier name used outside import declarations. */
  names: Set<string>;
  units: ModuleUnit[];
}

/**
 * One module being pruned: `program` is the AST of `source.original`, and
 * every edit already applied to `source` that dropped code is in `removed`.
 */
interface DeadCodeState {
  /** References of the module before the transform stripped anything. */
  before: ModuleReferences;
  /** Bindings the transform knows to be server-only, whatever their initializer. */
  forced: ReadonlySet<string>;
  program: Program;
  removed: SourceRange[];
  /** Names referenced by code the transform inserted into `source`. */
  retained: ReadonlySet<string>;
  source: MagicString;
}

function isTypeAssertion(
  node: Node
): node is TSAsExpression | TSSatisfiesExpression | TSTypeAssertion {
  return TYPE_ASSERTION_NODES.has(node.type);
}

/** Identifiers a pattern declares are not reads; its default values are. */
function excludeBindingIdentifiers(node: Node | null, excluded: Set<Node>): void {
  if (!node) {
    return;
  }
  if (node.type === "Identifier") {
    excluded.add(node);
  } else if (node.type === "AssignmentPattern") {
    excludeBindingIdentifiers(node.left, excluded);
  } else if (node.type === "RestElement") {
    excludeBindingIdentifiers(node.argument, excluded);
  } else if (node.type === "ArrayPattern") {
    for (const element of node.elements) {
      excludeBindingIdentifiers(element, excluded);
    }
  } else if (node.type === "ObjectPattern") {
    for (const property of node.properties) {
      excludeBindingIdentifiers(property.type === "Property" ? property.value : property, excluded);
    }
  }
}

function excludeDeclaredIdentifiers(node: Node, excluded: Set<Node>): void {
  if (node.type === "VariableDeclarator") {
    excludeBindingIdentifiers(node.id, excluded);
  } else if (
    node.type === "FunctionDeclaration" ||
    node.type === "FunctionExpression" ||
    node.type === "ArrowFunctionExpression"
  ) {
    excludeBindingIdentifiers(node.id, excluded);
    for (const parameter of node.params) {
      excludeBindingIdentifiers(parameter, excluded);
    }
  } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
    excludeBindingIdentifiers(node.id, excluded);
  } else if (node.type === "CatchClause") {
    excludeBindingIdentifiers(node.param, excluded);
  }
}

function collectReferences(
  value: unknown,
  removed: readonly SourceRange[],
  excluded: Set<Node>,
  references: Set<string>
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectReferences(item, removed, excluded, references);
    }
    return;
  }
  if (
    !isNode(value) ||
    excluded.has(value) ||
    TYPE_SCOPE_NODES.has(value.type) ||
    isRemoved(value, removed)
  ) {
    return;
  }
  const node = value;
  if (node.type === "Property" && !node.computed) {
    excluded.add(node.key);
  }
  if (node.type === "MemberExpression" && !node.computed) {
    excluded.add(node.property);
  }
  if (node.type === "JSXAttribute") {
    excluded.add(node.name);
  }
  if (node.type === "JSXMemberExpression") {
    excluded.add(node.property);
  }
  if (isTypeAssertion(node)) {
    excluded.add(node.typeAnnotation);
  }
  excludeDeclaredIdentifiers(node, excluded);
  if (node.type === "Identifier" || node.type === "JSXIdentifier") {
    references.add(node.name);
  }
  for (const [key, child] of Object.entries(node)) {
    if (!WALK_SKIPPED_KEYS.has(key)) {
      collectReferences(child, removed, excluded, references);
    }
  }
}

/** Identifier names a node references outside `removed`, excluding property keys and types. */
export function referencedNames(node: Node, removed: readonly SourceRange[]): Set<string> {
  const references = new Set<string>();
  collectReferences(node, removed, new Set(), references);
  return references;
}

function collectPatternNames(node: Node | null, names: string[]): void {
  if (!node) {
    return;
  }
  if (node.type === "Identifier") {
    names.push(node.name);
  } else if (node.type === "AssignmentPattern") {
    collectPatternNames(node.left, names);
  } else if (node.type === "RestElement") {
    collectPatternNames(node.argument, names);
  } else if (node.type === "ArrayPattern") {
    for (const element of node.elements) {
      collectPatternNames(element, names);
    }
  } else if (node.type === "ObjectPattern") {
    for (const property of node.properties) {
      collectPatternNames(property.type === "Property" ? property.value : property, names);
    }
  }
}

function moduleUnits(program: Program): Omit<ModuleUnit, "references">[] {
  const units: Omit<ModuleUnit, "references">[] = [];
  for (const statement of program.body) {
    if (statement.type === "ImportDeclaration") {
      continue;
    }
    const exported =
      statement.type === "ExportNamedDeclaration" || statement.type === "ExportDefaultDeclaration";
    const declaration = exported ? statement.declaration : statement;
    if (declaration?.type === "VariableDeclaration") {
      for (const declarator of declaration.declarations) {
        const names: string[] = [];
        collectPatternNames(declarator.id, names);
        units.push({ declaration, exported, names, node: declarator });
      }
      continue;
    }
    const id = declaration?.type === "FunctionDeclaration" ? declaration.id : null;
    units.push({
      declaration: null,
      exported,
      names: id ? [id.name] : [],
      node: statement,
    });
  }
  return units;
}

function collectModuleReferences(
  program: Program,
  removed: readonly SourceRange[]
): ModuleReferences {
  const names = new Set<string>();
  const units = moduleUnits(program).map((unit) => {
    const references = new Set<string>();
    collectReferences(unit.node, removed, new Set(), references);
    for (const name of references) {
      names.add(name);
    }
    return { ...unit, references };
  });
  return { names, units };
}

function referencedOutsideDeclaration(references: ModuleReferences, name: string): boolean {
  return references.units.some((unit) => !unit.names.includes(name) && unit.references.has(name));
}

function isSideEffectFree(value: Node | null): boolean {
  if (!value) {
    return true;
  }
  const node = unwrapTSExpression(value);
  switch (node.type) {
    case "ArrowFunctionExpression":
    case "FunctionExpression":
    case "Identifier":
    case "Literal":
      return true;
    case "TemplateLiteral":
      return node.expressions.every(isSideEffectFree);
    case "ArrayExpression":
      return node.elements.every(
        (element) =>
          element === null || (element.type !== "SpreadElement" && isSideEffectFree(element))
      );
    case "ObjectExpression":
      return node.properties.every(
        (property) =>
          property.type === "Property" &&
          (!property.computed || isSideEffectFree(property.key)) &&
          isSideEffectFree(property.value)
      );
    default:
      return false;
  }
}

function isPatternSideEffectFree(node: Node | null): boolean {
  if (!node) {
    return true;
  }
  switch (node.type) {
    case "AssignmentPattern":
      return isPatternSideEffectFree(node.left) && isSideEffectFree(node.right);
    case "RestElement":
      return isPatternSideEffectFree(node.argument);
    case "ArrayPattern":
      return node.elements.every(isPatternSideEffectFree);
    case "ObjectPattern":
      return node.properties.every((property) =>
        property.type === "Property"
          ? (!property.computed || isSideEffectFree(property.key)) &&
            isPatternSideEffectFree(property.value)
          : isPatternSideEffectFree(property)
      );
    default:
      return true;
  }
}

function isDeadBinding(unit: ModuleUnit, after: ModuleReferences, state: DeadCodeState): boolean {
  if (
    unit.exported ||
    unit.names.length === 0 ||
    unit.names.some((name) => state.retained.has(name) || referencedOutsideDeclaration(after, name))
  ) {
    return false;
  }
  if (unit.names.some((name) => state.forced.has(name))) {
    return true;
  }
  // A binding unused before the transform is kept: the user may rely on its
  // initialization. Only bindings the transform orphaned are candidates.
  return (
    unit.names.some((name) => referencedOutsideDeclaration(state.before, name)) &&
    (unit.declaration === null ||
      (unit.node.type === "VariableDeclarator" &&
        isPatternSideEffectFree(unit.node.id) &&
        isSideEffectFree(unit.node.init)))
  );
}

type EditedModule = Pick<ModuleTransform, "removed" | "source">;

function removeRange(module: EditedModule, start: number, end: number): void {
  module.source.remove(start, end);
  module.removed.push({ end, start });
}

/** Removes one declarator, or its whole declaration once it is the last one left. */
export function removeDeclarator(
  module: EditedModule,
  declaration: VariableDeclaration,
  node: VariableDeclarator
): void {
  const declarators = declaration.declarations.filter(
    (declarator) => declarator === node || !isRemoved(declarator, module.removed)
  );
  if (declarators.length === 1) {
    removeRange(module, declaration.start, declaration.end);
    return;
  }
  const index = declarators.indexOf(node);
  const next = declarators[index + 1];
  if (next) {
    removeRange(module, node.start, next.start);
    return;
  }
  const previous = declarators[index - 1];
  if (previous) {
    removeRange(module, previous.end, node.end);
  }
}

function removeUnit(unit: ModuleUnit, state: DeadCodeState): void {
  const { declaration, node } = unit;
  if (!declaration || node.type !== "VariableDeclarator") {
    removeRange(state, node.start, node.end);
    return;
  }
  removeDeclarator(state, declaration, node);
}

/**
 * Removes top-level bindings the transform orphaned, repeating until no more
 * become unreferenced (babel-dead-code-elimination's approach): a stripped
 * `.loader(loadData)` must not leave `loadData` and its server imports behind.
 */
function pruneDeadBindings(state: DeadCodeState): void {
  for (;;) {
    const after = collectModuleReferences(state.program, state.removed);
    const dead = after.units.filter(
      (unit) => !isRemoved(unit.node, state.removed) && isDeadBinding(unit, after, state)
    );
    if (dead.length === 0) {
      return;
    }
    for (const unit of dead) {
      removeUnit(unit, state);
    }
  }
}

function preserveImportSideEffect(source: MagicString, declaration: ImportDeclaration): void {
  source.overwrite(
    declaration.start,
    declaration.end,
    `import ${source.slice(declaration.source.start, declaration.source.end)};`
  );
}

function removeEntireImport(source: MagicString, declaration: ImportDeclaration): void {
  const code = source.original;
  let removeEnd = declaration.end;
  while (removeEnd < code.length && (code[removeEnd] === "\n" || code[removeEnd] === "\r")) {
    removeEnd += 1;
  }
  source.remove(declaration.start, removeEnd);
}

function removeUnusedSpecifiers(
  source: MagicString,
  declaration: ImportDeclaration,
  references: ReadonlySet<string>
): void {
  const code = source.original;
  const removedSpecifiers = declaration.specifiers.filter(
    (specifier) => !references.has(specifier.local.name)
  );
  for (const specifier of removedSpecifiers) {
    let removeStart = specifier.start;
    let removeEnd = specifier.end;
    while (removeEnd < code.length && (code[removeEnd] === "," || code[removeEnd] === " ")) {
      removeEnd += 1;
    }
    // react-doctor-disable-next-line react-doctor/js-set-map-lookups
    if (!code.slice(specifier.end, removeEnd).includes(",")) {
      while (removeStart > 0 && (code[removeStart - 1] === " " || code[removeStart - 1] === ",")) {
        removeStart -= 1;
      }
    }
    source.remove(removeStart, removeEnd);
  }
}

/** Drops import specifiers no remaining code references. */
function pruneDeadImports(state: DeadCodeState): void {
  const references = collectModuleReferences(state.program, state.removed).names.union(
    state.retained
  );
  const { body } = state.program;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const statement = body[index];
    if (statement?.type !== "ImportDeclaration") {
      continue;
    }
    const declaration = statement;
    if (declaration.specifiers.length === 0) {
      continue;
    }

    const usedCount = declaration.specifiers.filter((specifier) =>
      references.has(specifier.local.name)
    ).length;
    if (usedCount === 0) {
      const typeOnly =
        declaration.importKind === "type" ||
        declaration.specifiers.every(
          (specifier) => specifier.type === "ImportSpecifier" && specifier.importKind === "type"
        );
      const wasUsedBeforeTransform = declaration.specifiers.some((specifier) =>
        state.before.names.has(specifier.local.name)
      );
      if (typeOnly || wasUsedBeforeTransform) {
        removeEntireImport(state.source, declaration);
      } else {
        preserveImportSideEffect(state.source, declaration);
      }
    } else if (usedCount < declaration.specifiers.length) {
      removeUnusedSpecifiers(state.source, declaration, references);
    }
  }
}

function reparse(
  transformed: MagicString,
  originalCode: string,
  lang: SourceLang
): DeadCodeState | null {
  const code = transformed.toString();
  const { program, diagnostics } = parseSource(code, lang);
  const firstError = diagnostics.find((diagnostic) => diagnostic.severity === "error");
  if (firstError) {
    console.error("[furin] DCE: failed to parse transformed output:", firstError.message);
    return null;
  }
  const originalParse = parseSource(originalCode, lang);
  const before = originalParse.diagnostics.some((diagnostic) => diagnostic.severity === "error")
    ? collectModuleReferences(program, [])
    : collectModuleReferences(originalParse.program, []);
  return {
    before,
    forced: new Set(),
    program,
    removed: [],
    retained: new Set(),
    source: new MagicString(code),
  };
}

/** Prunes imports the transform orphaned; top-level bindings are left untouched. */
export function deadCodeElimination(
  transformed: MagicString,
  originalCode: string,
  lang: SourceLang
): MagicString {
  const state = reparse(transformed, originalCode, lang);
  if (!state) {
    return transformed;
  }
  pruneDeadImports(state);
  return state.source;
}

/**
 * Prunes the top-level bindings, then the imports, the module's edits
 * orphaned. `forced` bindings are server-only whatever their initializer;
 * `retained` names are referenced by code the transform inserted.
 */
export function pruneOrphanedCode(
  module: ModuleTransform,
  forced: ReadonlySet<string>,
  retained: ReadonlySet<string>
): void {
  const state: DeadCodeState = {
    before: collectModuleReferences(module.program, []),
    forced,
    program: module.program,
    removed: module.removed,
    retained,
    source: module.source,
  };
  pruneDeadBindings(state);
  pruneDeadImports(state);
}
