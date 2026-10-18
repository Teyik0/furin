import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { walk } from "yuku-ast";
import type { Program } from "yuku-parser";
import type { DevDiagnosticStore } from "../server/dev/diagnostics.ts";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseDynamicRouteSegment } from "../server/router/patterns.ts";
import { parseSource } from "../shared/parser.ts";
import type { AstNode } from "../shared/utils/ast-walk.ts";
import { FactoryBindings, fluentChain } from "./binding-scope.ts";
import { routeSourcePaths } from "./routes.ts";

/**
 * Static route-config checks shared by the dev server and `furin build`.
 * Furin never rewrites route sources: it reports what TypeScript cannot see
 * because it depends on the file's place in the pages tree, with the code to
 * write. Files that do not parse are skipped; the transform reports them.
 */
export interface RouteConfigIssue {
  column: number;
  file: string;
  line: number;
  message: string;
}

const FURIN_MODULES = new Set(["@teyik0/furin", "furin"]);
const LAYOUT_FILE_NAMES = ["_route.tsx", "_route.ts", "_route.jsx", "_route.js"];
const EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/;
const NON_ALPHANUMERIC_RE = /[^a-zA-Z0-9]/g;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const PATH_SEPARATOR_RE = /[\\/]/;

interface Import {
  imported: string;
  specifier: string;
}

interface RouteExport {
  /** `config({...})` argument, when the chain declares one. */
  config: AstNode | undefined;
  head: AstNode;
  isRootFactory: boolean;
  methods: Set<string>;
}

interface ParsedRoute {
  imports: Map<string, Import>;
  route: RouteExport;
  source: string;
}

function withoutExtension(path: string): string {
  return path.replace(EXTENSION_RE, "");
}

function propertyName(node: unknown): string | undefined {
  const key = node as AstNode | undefined;
  if (key?.type === "Identifier" && typeof key.name === "string") {
    return key.name;
  }
  if (key?.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
}

function findProperty(object: AstNode, name: string): AstNode | undefined {
  return (object.properties as AstNode[]).find(
    (property) => property.type === "Property" && propertyName(property.key) === name
  );
}

function collectImports(program: Program): Map<string, Import> {
  const imports = new Map<string, Import>();
  for (const statement of program.body as unknown as AstNode[]) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
      continue;
    }
    const specifier = (statement.source as AstNode).value;
    for (const entry of statement.specifiers as AstNode[]) {
      const imported = propertyName(entry.imported);
      const local = propertyName(entry.local);
      if (entry.type === "ImportSpecifier" && imported && local && typeof specifier === "string") {
        imports.set(local, { imported, specifier });
      }
    }
  }
  return imports;
}

/** `export const route = defineRoute()...` — the only export route discovery reads. */
function findRouteExport(program: Program, imports: Map<string, Import>): RouteExport | undefined {
  const factories = new Set<string>();
  for (const [local, { imported, specifier }] of imports) {
    if (
      FURIN_MODULES.has(specifier) &&
      (imported === "defineRoute" || imported === "defineRootRoute")
    ) {
      factories.add(local);
    }
  }
  const bindings = new FactoryBindings(program, factories, new Set());
  let found: RouteExport | undefined;
  walk(program as never, {
    CallExpression(call, context) {
      const ancestors = context.ancestors() as AstNode[];
      const head = call as unknown as AstNode;
      const factory = bindings.factoryName(head.callee as AstNode, ancestors);
      if (factory === undefined) {
        return;
      }
      const chain = fluentChain(head, ancestors);
      const declarator = ancestors.findLast((ancestor) => ancestor.type === "VariableDeclarator");
      if (
        declarator === undefined ||
        unwrapTSExpression(declarator.init as AstNode) !== chain ||
        propertyName(declarator.id) !== "route" ||
        !ancestors.some((ancestor) => ancestor.type === "ExportNamedDeclaration")
      ) {
        return;
      }
      found = {
        ...chainCalls(chain, head),
        head,
        isRootFactory: imports.get(factory)?.imported === "defineRootRoute",
      };
    },
  });
  return found;
}

function chainCalls(
  chain: AstNode,
  head: AstNode
): { config: AstNode | undefined; methods: Set<string> } {
  let config: AstNode | undefined;
  const methods = new Set<string>();
  let current: AstNode = chain;
  while (current !== head && current.type === "CallExpression") {
    const callee = unwrapTSExpression(current.callee as AstNode);
    const method = propertyName(callee.property);
    if (callee.type !== "MemberExpression" || method === undefined) {
      break;
    }
    methods.add(method);
    const [argument] = current.arguments as AstNode[];
    if (method === "config" && argument?.type === "ObjectExpression") {
      config = argument;
    }
    current = unwrapTSExpression(callee.object as AstNode);
  }
  return { config, methods };
}

/** Undefined when the file disappeared between the directory scan and the read. */
function readSource(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    // Deleted or renamed mid-scan; the next watcher refresh sees the new tree.
  }
}

function parseRoute(file: string): ParsedRoute | undefined {
  const source = readSource(file);
  if (source === undefined) {
    return;
  }
  const { diagnostics, program } = parseSource(source, detectLangFromPath(file));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return;
  }
  const imports = collectImports(program);
  const route = findRouteExport(program, imports);
  return route ? { imports, route, source } : undefined;
}

/** Nearest `_route` above the file (its parent directory's for a `_route`), else `root.tsx`. */
function expectedLayoutPath(file: string, pagesDir: string): string | undefined {
  const directory = dirname(file);
  const isLayout = withoutExtension(file) === join(directory, "_route");
  let current = isLayout ? dirname(directory) : directory;
  while (current.startsWith(pagesDir) && current !== pagesDir) {
    const layout = LAYOUT_FILE_NAMES.map((name) => join(current, name)).find(existsSync);
    if (layout) {
      return layout;
    }
    current = dirname(current);
  }
  const root = join(pagesDir, "root.tsx");
  return existsSync(root) ? root : undefined;
}

function layoutBinding(layoutPath: string): string {
  const stem = withoutExtension(layoutPath);
  const name = stem.endsWith("_route") ? dirname(stem).split(PATH_SEPARATOR_RE).pop() : "root";
  return `${(name ?? "").replace(NON_ALPHANUMERIC_RE, "") || "root"}Route`;
}

function importSpecifier(fromFile: string, toFile: string): string {
  const specifier = withoutExtension(relative(dirname(fromFile), toFile)).replaceAll("\\", "/");
  return specifier.startsWith(".") ? specifier : `./${specifier}`;
}

function position(source: string, offset: number): { column: number; line: number } {
  const before = source.slice(0, offset);
  return { column: offset - before.lastIndexOf("\n"), line: before.split("\n").length };
}

function issueAt(
  file: string,
  parsed: ParsedRoute,
  node: AstNode,
  message: string
): RouteConfigIssue {
  return { file, ...position(parsed.source, node.start), message };
}

function layoutFix(file: string, layoutPath: string): string {
  const identifier = layoutBinding(layoutPath);
  return `Import it and pass it:\n  import { route as ${identifier} } from "${importSpecifier(file, layoutPath)}";\n  .config({ layout: ${identifier}, ... })`;
}

function checkLayout(
  file: string,
  pagesDir: string,
  parsed: ParsedRoute
): RouteConfigIssue | undefined {
  const { config } = parsed.route;
  const expected = expectedLayoutPath(file, pagesDir);
  if (!(config && expected)) {
    return;
  }
  const property = findProperty(config, "layout");
  if (!property) {
    return issueAt(
      file,
      parsed,
      config,
      `config() must declare layout: the nearest layout is ${relative(pagesDir, expected)}. ${layoutFix(file, expected)}`
    );
  }
  const layout = unwrapTSExpression(property.value as AstNode);
  const binding =
    layout.type === "Identifier" ? parsed.imports.get(String(layout.name)) : undefined;
  if (!(binding?.imported === "route" && binding.specifier.startsWith("."))) {
    return;
  }
  const target = withoutExtension(resolve(dirname(file), binding.specifier));
  if (target === withoutExtension(expected)) {
    return;
  }
  return issueAt(
    file,
    parsed,
    layout,
    `config({ layout }) must reference the nearest layout, ${relative(pagesDir, expected)}. ${layoutFix(file, expected)}`
  );
}

/** Declared mode, else the one the runtime infers from the local chain. */
function suggestedMode(route: RouteExport, isRoot: boolean): string {
  const declared = (route.config && findProperty(route.config, "mode"))?.value as
    | AstNode
    | undefined;
  if (declared?.type === "Literal" && typeof declared.value === "string") {
    return declared.value;
  }
  if (isRoot) {
    return "ssr";
  }
  if (route.config && findProperty(route.config, "revalidate")) {
    return "isr";
  }
  return route.methods.has("loader") || route.methods.has("requestLoader") ? "ssr" : "ssg";
}

/** `import { route as blogRoute } from "./_route";` and its `layout: blogRoute, ` entry. */
function layoutSnippets(file: string, pagesDir: string): { entry: string; importLine: string } {
  const expected = expectedLayoutPath(file, pagesDir);
  if (!expected) {
    return { entry: "", importLine: "" };
  }
  const identifier = layoutBinding(expected);
  return {
    entry: `layout: ${identifier}, `,
    importLine: `\n  import { route as ${identifier} } from "${importSpecifier(file, expected)}";`,
  };
}

function checkFactory(
  file: string,
  pagesDir: string,
  parsed: ParsedRoute
): RouteConfigIssue | undefined {
  const { route } = parsed;
  const isRoot = withoutExtension(file) === join(pagesDir, "root");
  if (isRoot === route.isRootFactory) {
    return;
  }
  const mode = suggestedMode(route, isRoot);
  if (isRoot) {
    return issueAt(
      file,
      parsed,
      route.head,
      `root.tsx must use defineRootRoute(), which has no parent layout:\n  import { defineRootRoute } from "@teyik0/furin";\n  export const route = defineRootRoute().config({ mode: "${mode}" })`
    );
  }
  const { entry, importLine } = layoutSnippets(file, pagesDir);
  return issueAt(
    file,
    parsed,
    route.head,
    `defineRootRoute() is reserved for root.tsx. Use defineRoute() with the nearest layout:\n  import { defineRoute } from "@teyik0/furin";${importLine}\n  export const route = defineRoute().config({ ${entry}mode: "${mode}" })`
  );
}

function checkConfig(
  file: string,
  pagesDir: string,
  parsed: ParsedRoute
): RouteConfigIssue | undefined {
  const { route } = parsed;
  if (route.config) {
    return;
  }
  const { entry, importLine } = route.isRootFactory
    ? { entry: "", importLine: "" }
    : layoutSnippets(file, pagesDir);
  return issueAt(
    file,
    parsed,
    route.head,
    `${route.isRootFactory ? "defineRootRoute" : "defineRoute"}() must be followed by config(). Add:${importLine}\n  .config({ ${entry}mode: "${suggestedMode(route, route.isRootFactory)}" })`
  );
}

function checkMode(file: string, parsed: ParsedRoute): RouteConfigIssue | undefined {
  const { route } = parsed;
  if (!route.config || findProperty(route.config, "mode")) {
    return;
  }
  return issueAt(
    file,
    parsed,
    route.config,
    `config() must declare mode ("ssg", "ssr" or "isr"), e.g. mode: "${suggestedMode(route, route.isRootFactory)}".`
  );
}

/** Keys of an inline `params: t.Object({ ... })`; `true` when the schema cannot be read statically. */
function declaredParams(parsed: ParsedRoute | undefined): Set<string> | true {
  const value = parsed?.route.config && findProperty(parsed.route.config, "params")?.value;
  if (!parsed || value === undefined) {
    return parsed ? new Set() : true;
  }
  const schema = unwrapTSExpression(value as AstNode);
  const shape = schema.type === "CallExpression" ? (schema.arguments as AstNode[])[0] : undefined;
  const properties = shape?.type === "ObjectExpression" ? (shape.properties as AstNode[]) : [];
  const keys = properties.map((property) =>
    property.type === "Property" ? propertyName(property.key) : undefined
  );
  if (!shape || keys.includes(undefined)) {
    return true;
  }
  return new Set(keys as string[]);
}

/** Dynamic segments of the file's path that neither it nor a layout above it declares. */
function undeclaredSegments(
  file: string,
  pagesDir: string,
  own: Set<string> | true,
  parse: (file: string) => ParsedRoute | undefined
): { key: string; segment: string }[] {
  const declared = [own];
  for (let layout = expectedLayoutPath(file, pagesDir); layout; ) {
    declared.push(declaredParams(parse(layout)));
    const parent = expectedLayoutPath(layout, pagesDir);
    layout = parent === layout ? undefined : parent;
  }
  return withoutExtension(relative(pagesDir, file))
    .split(PATH_SEPARATOR_RE)
    .flatMap((segment) => {
      const dynamic = parseDynamicRouteSegment(segment, file);
      return dynamic ? [{ key: dynamic.catchAll ? "*" : dynamic.name, segment }] : [];
    })
    .filter(({ key }) => declared.every((keys) => keys !== true && !keys.has(key)));
}

function paramsSchema(segments: { key: string }[]): string {
  const fields = segments.map(
    ({ key }) => `${IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)}: t.String()`
  );
  return `params: t.Object({ ${fields.join(", ")} })`;
}

function checkParams(
  file: string,
  pagesDir: string,
  parsed: ParsedRoute,
  parse: (file: string) => ParsedRoute | undefined
): RouteConfigIssue | undefined {
  const missing = undeclaredSegments(file, pagesDir, declaredParams(parsed), parse);
  if (missing.length === 0) {
    return;
  }
  const plural = missing.length > 1;
  const tImport =
    parsed.imports.get("t")?.specifier === "elysia" ? "" : '\n  import { t } from "elysia";';
  return issueAt(
    file,
    parsed,
    parsed.route.config ?? parsed.route.head,
    `The URL segment${plural ? "s" : ""} ${missing.map(({ segment }) => segment).join(", ")} ${plural ? "are" : "is"} not declared by a params schema of this route or its layouts. Declare ${plural ? "them" : "it"} in config():${tImport}\n  ${paramsSchema(missing)}`
  );
}

function checkRoute(
  file: string,
  pagesDir: string,
  parsed: ParsedRoute,
  parse: (file: string) => ParsedRoute | undefined
): (RouteConfigIssue | undefined)[] {
  const factory = checkFactory(file, pagesDir, parsed);
  if (factory) {
    return [factory];
  }
  const isLayout = basename(withoutExtension(file)) === "_route";
  return [
    checkConfig(file, pagesDir, parsed),
    parsed.route.isRootFactory ? undefined : checkLayout(file, pagesDir, parsed),
    checkMode(file, parsed),
    parsed.route.isRootFactory || isLayout ? undefined : checkParams(file, pagesDir, parsed, parse),
  ];
}

function routeFiles(pagesDir: string): string[] {
  const root = join(pagesDir, "root.tsx");
  return [
    ...(existsSync(root) ? [root] : []),
    ...routeSourcePaths({ pagesDir, prefix: "" }),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function validateRouteConfig(pagesDir: string): RouteConfigIssue[] {
  const pages = resolve(pagesDir);
  const files = routeFiles(pages);
  const parsedFiles = new Map<string, ParsedRoute | undefined>();
  const parse = (file: string): ParsedRoute | undefined => {
    if (!parsedFiles.has(file)) {
      parsedFiles.set(file, parseRoute(file));
    }
    return parsedFiles.get(file);
  };
  return files.flatMap((file) => {
    const parsed = parse(file);
    return parsed
      ? checkRoute(file, pages, parsed, parse).filter((issue) => issue !== undefined)
      : [];
  });
}

function displayPath(file: string): string {
  const projected = relative(process.cwd(), file).replaceAll("\\", "/");
  return projected.startsWith("../") ? file : projected;
}

export function formatRouteConfigIssue(issue: RouteConfigIssue): string {
  return `[furin] ${displayPath(issue.file)}:${issue.line}:${issue.column}: ${issue.message}`;
}

/** Build and typegen: fails before route modules are imported. */
export function assertValidRouteConfig(pagesDir: string): void {
  const issues = validateRouteConfig(pagesDir);
  if (issues.length > 0) {
    throw new Error(issues.map(formatRouteConfigIssue).join("\n\n"));
  }
}

/** Diagnostic route label: clearing it can never hide another diagnostic. */
const ROUTE_CONFIG_DIAGNOSTIC = "route config";

/**
 * Dev: shows the first issue in the terminal and the error overlay, and
 * clears the overlay once the route files are valid again.
 */
export function createRouteConfigReporter(pagesDir: string, store: DevDiagnosticStore): () => void {
  let reported: string | undefined;
  return () => {
    const [issue] = validateRouteConfig(pagesDir);
    if (!issue) {
      store.markReady(ROUTE_CONFIG_DIAGNOSTIC);
      reported = undefined;
      return;
    }
    const message = formatRouteConfigIssue(issue);
    if (message !== reported) {
      console.error(message);
    }
    reported = message;
    const file = displayPath(issue.file);
    store.publish({
      cause: undefined,
      frames: [],
      importChain: [file],
      location: { column: issue.column, file, line: issue.line },
      message,
      phase: "transform",
      route: ROUTE_CONFIG_DIAGNOSTIC,
      stack: undefined,
    });
  };
}

const ROOT_TEMPLATE = `import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .layout(({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  ));
`;

function scaffoldTemplate(file: string, pagesDir: string): string | undefined {
  if (withoutExtension(file) === join(pagesDir, "root")) {
    return ROOT_TEMPLATE;
  }
  const layout = expectedLayoutPath(file, pagesDir);
  if (!layout) {
    return;
  }
  const isLayout = basename(withoutExtension(file)) === "_route";
  const identifier = layoutBinding(layout);
  const params = undeclaredSegments(file, pagesDir, new Set(), parseRoute);
  return `import { defineRoute } from "@teyik0/furin";${params.length > 0 ? '\nimport { t } from "elysia";' : ""}
import { route as ${identifier} } from "${importSpecifier(file, layout)}";

export const route = defineRoute()
  .config({ layout: ${identifier}, mode: "${isLayout ? "ssr" : "ssg"}"${params.length > 0 ? `, ${paramsSchema(params)}` : ""} })
  .${isLayout ? "layout(({ children }) => children)" : "page(() => null)"};
`;
}

/**
 * Writes a starter route into route files that are empty or whitespace-only,
 * the only case where Furin writes to a source file. Layouts go first so a
 * page template only declares the params its layouts do not.
 */
export function scaffoldEmptyRoutes(pagesDir: string): string[] {
  const pages = resolve(pagesDir);
  const depth = (file: string): number =>
    basename(withoutExtension(file)) === "_route" || file === join(pages, "root.tsx")
      ? file.split("/").length
      : Number.MAX_SAFE_INTEGER;
  const written: string[] = [];
  for (const file of routeFiles(pages)
    .filter((path) => readSource(path)?.trim() === "")
    .toSorted((left, right) => depth(left) - depth(right))) {
    const template = scaffoldTemplate(file, pages);
    if (template) {
      writeFileSync(file, template);
      written.push(file);
    }
  }
  return written.toSorted((left, right) => left.localeCompare(right));
}
