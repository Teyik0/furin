import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { CallExpression, Node, ObjectExpression, ObjectProperty, Program } from "yuku-parser";
import type { DevDiagnosticStore } from "../server/dev/diagnostics.ts";
import { detectLangFromPath, unwrapTSExpression } from "../server/lang-detect.ts";
import { parseDynamicRouteSegment } from "../server/router/patterns.ts";
import { parseSource } from "../shared/parser.ts";
import { collectDefineRouteBindings, exportedRouteChain } from "./route-chains.ts";
import { fileRouteId, type RouteInstanceSpec, routeSourcePaths } from "./route-tree.ts";

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

const EXTENSION_RE = /\.(?:[cm]?[jt]sx?)$/;
const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const PATH_SEPARATOR_RE = /[\\/]/;

interface Import {
  imported: string;
  specifier: string;
}

interface RouteExport {
  /** `config({...})` argument, when the chain declares one. */
  config: ObjectExpression | undefined;
  head: CallExpression;
  /** First argument of `defineRoute(id)`. */
  id: Node | undefined;
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

function propertyName(key: Node | null): string | undefined {
  if (key?.type === "Identifier") {
    return key.name;
  }
  if (key?.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
}

function findProperty(object: ObjectExpression, name: string): ObjectProperty | undefined {
  return object.properties.find(
    (property): property is ObjectProperty =>
      property.type === "Property" && propertyName(property.key) === name
  );
}

function collectImports(program: Program): Map<string, Import> {
  const imports = new Map<string, Import>();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.importKind === "type") {
      continue;
    }
    const specifier = statement.source.value;
    for (const entry of statement.specifiers) {
      if (entry.type !== "ImportSpecifier") {
        continue;
      }
      const imported = propertyName(entry.imported);
      const local = propertyName(entry.local);
      if (imported && local) {
        imports.set(local, { imported, specifier });
      }
    }
  }
  return imports;
}

/** The `export const route` chain, as every transform reads it. */
function findRouteExport(program: Program, imports: Map<string, Import>): RouteExport | undefined {
  const chain = exportedRouteChain(program, collectDefineRouteBindings(program));
  if (!chain) {
    return;
  }
  let config: ObjectExpression | undefined;
  const methods = new Set<string>();
  for (const { call, method } of chain.calls) {
    methods.add(method);
    const [argument] = call.arguments;
    if (method === "config" && argument?.type === "ObjectExpression") {
      config = argument;
    }
  }
  return {
    config,
    head: chain.head,
    id: chain.head.arguments[0],
    isRootFactory: imports.get(chain.factory)?.imported === "defineRootRoute",
    methods,
  };
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

function position(source: string, offset: number): { column: number; line: number } {
  const before = source.slice(0, offset);
  return { column: offset - before.lastIndexOf("\n"), line: before.split("\n").length };
}

function issueAt(file: string, parsed: ParsedRoute, node: Node, message: string): RouteConfigIssue {
  return { file, ...position(parsed.source, node.start), message };
}

/**
 * `defineRoute(id)` names its file: the app's prefix, then the file's place in
 * the pages tree. The parent layout comes from that tree, never from config().
 */
function checkKey(
  file: string,
  instance: RouteInstanceSpec,
  parsed: ParsedRoute
): RouteConfigIssue | undefined {
  const { config, head, id } = parsed.route;
  const expected = fileRouteId(instance, file);
  if (!id) {
    return issueAt(
      file,
      parsed,
      head,
      `defineRoute() must name this file. Its id is "${expected}":\n  defineRoute("${expected}")`
    );
  }
  const key = unwrapTSExpression(id);
  if (!(key.type === "Literal" && key.value === expected)) {
    const written = key.type === "Literal" ? JSON.stringify(key.value) : "id";
    return issueAt(
      file,
      parsed,
      key,
      `defineRoute(${written}) does not match this file. Its id is "${expected}":\n  defineRoute("${expected}")`
    );
  }
  const layout = config && findProperty(config, "layout");
  if (layout) {
    return issueAt(
      file,
      parsed,
      layout,
      "defineRoute(id) reads the parent layout from the pages tree: remove layout from config() and its import."
    );
  }
}

/** Declared mode, else the one the runtime infers from the local chain. */
function suggestedMode(route: RouteExport, isRoot: boolean): string {
  const declared = (route.config && findProperty(route.config, "mode"))?.value;
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

function checkFactory(
  file: string,
  instance: RouteInstanceSpec,
  parsed: ParsedRoute
): RouteConfigIssue | undefined {
  const { route } = parsed;
  const isRoot = withoutExtension(file) === join(instance.pagesDir, "root");
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
  return issueAt(
    file,
    parsed,
    route.head,
    `defineRootRoute() is reserved for root.tsx. Use defineRoute with this file's id:\n  import { defineRoute } from "@teyik0/furin";\n  export const route = defineRoute("${fileRouteId(instance, file)}").config({ mode: "${mode}" })`
  );
}

function checkConfig(file: string, parsed: ParsedRoute): RouteConfigIssue | undefined {
  const { route } = parsed;
  if (route.config) {
    return;
  }
  return issueAt(
    file,
    parsed,
    route.head,
    `${route.isRootFactory ? "defineRootRoute" : "defineRoute"}() must be followed by config(). Add:\n  .config({ mode: "${suggestedMode(route, route.isRootFactory)}" })`
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
function declaredParams(route: RouteExport): Set<string> | true {
  const value = route.config && findProperty(route.config, "params")?.value;
  if (value === undefined) {
    return new Set();
  }
  const schema = unwrapTSExpression(value);
  const shape = schema.type === "CallExpression" ? schema.arguments[0] : undefined;
  const properties = shape?.type === "ObjectExpression" ? shape.properties : [];
  const keys = properties.map((property) =>
    property.type === "Property" ? propertyName(property.key) : undefined
  );
  if (!shape || keys.includes(undefined)) {
    return true;
  }
  return new Set(keys.filter((key) => key !== undefined));
}

/** Dynamic segments of the file's path missing from `declared`. */
function undeclaredSegments(
  file: string,
  pagesDir: string,
  declared: Set<string> | true
): { key: string; segment: string }[] {
  return withoutExtension(relative(pagesDir, file))
    .split(PATH_SEPARATOR_RE)
    .flatMap((segment) => {
      const dynamic = parseDynamicRouteSegment(segment, file);
      return dynamic ? [{ key: dynamic.catchAll ? "*" : dynamic.name, segment }] : [];
    })
    .filter(({ key }) => declared !== true && !declared.has(key));
}

function paramsSchema(segments: { key: string }[]): string {
  const fields = segments.map(
    ({ key }) => `${IDENTIFIER_RE.test(key) ? key : JSON.stringify(key)}: t.String()`
  );
  return `params: t.Object({ ${fields.join(", ")} })`;
}

/** Static twin of `validateRouteParams()`, which rejects the page once its module loads. */
function checkParams(
  file: string,
  pagesDir: string,
  parsed: ParsedRoute
): RouteConfigIssue | undefined {
  const missing = undeclaredSegments(file, pagesDir, declaredParams(parsed.route));
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
    `The URL segment${plural ? "s" : ""} ${missing.map(({ segment }) => segment).join(", ")} ${plural ? "are" : "is"} missing from this page's params schema. Each page declares every dynamic segment of its path, including those of its layouts. Add to config():${tImport}\n  ${paramsSchema(missing)}`
  );
}

function checkRoute(
  file: string,
  instance: RouteInstanceSpec,
  parsed: ParsedRoute
): (RouteConfigIssue | undefined)[] {
  const factory = checkFactory(file, instance, parsed);
  if (factory) {
    return [factory];
  }
  const isLayout = basename(withoutExtension(file)) === "_route";
  return [
    checkConfig(file, parsed),
    parsed.route.isRootFactory ? undefined : checkKey(file, instance, parsed),
    checkMode(file, parsed),
    parsed.route.isRootFactory || isLayout
      ? undefined
      : checkParams(file, instance.pagesDir, parsed),
  ];
}

function routeFiles(pagesDir: string): string[] {
  const root = join(pagesDir, "root.tsx");
  return [
    ...(existsSync(root) ? [root] : []),
    ...routeSourcePaths({ pagesDir, prefix: "" }),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function validateRouteConfig({ pagesDir, prefix }: RouteInstanceSpec): RouteConfigIssue[] {
  const instance = { pagesDir: resolve(pagesDir), prefix };
  return routeFiles(instance.pagesDir).flatMap((file) => {
    const parsed = parseRoute(file);
    return parsed ? checkRoute(file, instance, parsed).filter((issue) => issue !== undefined) : [];
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
export function assertValidRouteConfig(instance: RouteInstanceSpec): void {
  const issues = validateRouteConfig(instance);
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
export function createRouteConfigReporter(
  instance: RouteInstanceSpec,
  store: DevDiagnosticStore
): () => void {
  let reported: string | undefined;
  return () => {
    const [issue] = validateRouteConfig(instance);
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

function scaffoldTemplate(file: string, instance: RouteInstanceSpec): string {
  if (withoutExtension(file) === join(instance.pagesDir, "root")) {
    return ROOT_TEMPLATE;
  }
  const isLayout = basename(withoutExtension(file)) === "_route";
  const params = undeclaredSegments(file, instance.pagesDir, new Set());
  return `import { defineRoute } from "@teyik0/furin";${params.length > 0 ? '\nimport { t } from "elysia";' : ""}

export const route = defineRoute("${fileRouteId(instance, file)}")
  .config({ mode: "${isLayout ? "ssr" : "ssg"}"${params.length > 0 ? `, ${paramsSchema(params)}` : ""} })
  .${isLayout ? "layout(({ children }) => children)" : "page(() => null)"};
`;
}

/**
 * Writes a starter route, keyed by the file's id, into route files that are
 * empty or whitespace-only, the only case where Furin writes to a source file.
 */
export function scaffoldEmptyRoutes({ pagesDir, prefix }: RouteInstanceSpec): string[] {
  const instance = { pagesDir: resolve(pagesDir), prefix };
  const written: string[] = [];
  for (const file of routeFiles(instance.pagesDir).filter(
    (path) => readSource(path)?.trim() === ""
  )) {
    writeFileSync(file, scaffoldTemplate(file, instance));
    written.push(file);
  }
  return written;
}
