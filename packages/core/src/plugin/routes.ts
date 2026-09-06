import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type AnyElysia, Elysia } from "elysia";
import { type FurinNativeRouteContext, getFurinRenderer } from "../define-route.ts";
import { detectLoaderFromPath } from "../server/lang-detect.ts";
import { parseDynamicRouteSegment, routeSegmentToPattern } from "../server/router/patterns.ts";

const ROUTES_NAMESPACE_PREFIX = "furin-routes";
const ROUTES_REGISTRY_SPECIFIER = "furin/routes?registry";
const ROUTES_REGISTRY_FILTER = /^furin\/routes\?registry$/;
const ROUTE_FILE_FILTER = /^furin-route-file:.+$/;
const ROUTE_FILES_NAMESPACE = "furin-route-files";
const ROUTES_REGISTRY_FILE_FILTER = /[\\/]\.furin-routes-registry\.ts\?furin-virtual$/;
const CLIENT_ROUTES_NAMESPACE = "furin-routes-client";
const CLIENT_ROUTES_FILTER = /^(?:@teyik0\/furin|furin)\/routes$/;
const SERVER_ROUTES_FILTER = /^(?:@teyik0\/furin|furin)\/routes\?instance=.+$/;
const VIRTUAL_ROUTES_FILTER = /.*/;
const ROUTE_EXTENSION = /\.(?:jsx?|tsx?)$/;
const ROUTE_CONVENTIONS = new Set(["error", "not-found", "root"]);
const DEV_ROUTES_APPS_SYMBOL = Symbol.for("@teyik0/furin/dev-routes-apps");
const DEV_ROUTE_WATCHERS_SYMBOL = Symbol.for("@teyik0/furin/dev-route-watchers");
const DEV_ROUTES_FILE_FILTER = /[\\/]routes\.ts\?instance=[^&]+$/;

const devInstancesBySpecifier = new Map<string, RouteInstanceSpec>();
let devRoutesPluginRegistered = false;

interface DevRoutesApps {
  app: AnyElysia;
  shell: AnyElysia;
}

export interface RouteInstanceSpec {
  pagesDir: string;
  prefix: string;
}

export interface CreateRoutesPluginOptions {
  instances: RouteInstanceSpec[];
  target: "client" | "server";
}

export interface DevRouteTopologyWatcher {
  close: () => void;
}

export interface DevRouteTopologyWatcherOptions {
  instance: RouteInstanceSpec;
  onRouteFilesTouched?: () => Promise<void> | void;
  onTopologyChange: () => Promise<void> | void;
  pollIntervalMs: number;
}

interface DevRouteTopologyWatcherState extends DevRouteTopologyWatcherOptions {
  pending: boolean;
  refreshing: boolean;
  routeFilesSignature: string;
  source: string;
  timer: ReturnType<typeof setInterval>;
}

function instanceKey(instance: RouteInstanceSpec): string {
  return `${resolve(instance.pagesDir)}\0${instance.prefix}`;
}

export function routeModuleSpecifier(instance: RouteInstanceSpec): string {
  return `@teyik0/furin/routes?instance=${Bun.hash(instanceKey(instance)).toString(16)}`;
}

function instanceNamespace(instance: RouteInstanceSpec): string {
  return `${ROUTES_NAMESPACE_PREFIX}-${Bun.hash(instanceKey(instance)).toString(16)}`;
}

interface RouteFile {
  id: string;
  path: string;
  sourcePath: string;
}

interface RouteTreeNode {
  children: RouteTreeNode[];
  fileRoutes: RouteFile[];
  indexRoute: RouteFile | undefined;
  layout: RouteFile | undefined;
  name: string;
}

interface ScannedRouteFile {
  base: string;
  directorySegments: string[];
  sourcePath: string;
}

function scanRouteFiles(
  directory: string,
  directorySegments: string[],
  files: ScannedRouteFile[]
): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Underscore-prefixed directories are co-located private folders
      // (components, libs) — never route segments.
      if (entry.name.startsWith("_")) {
        continue;
      }
      scanRouteFiles(join(directory, entry.name), [...directorySegments, entry.name], files);
      continue;
    }
    const extension = extname(entry.name);
    if (!ROUTE_EXTENSION.test(extension) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    const base = entry.name.slice(0, -extension.length);
    const sourcePath = join(directory, entry.name);
    for (const segment of [...directorySegments, base]) {
      parseDynamicRouteSegment(segment, sourcePath);
    }
    if (ROUTE_CONVENTIONS.has(base)) {
      continue;
    }
    // Underscore-prefixed files are private co-located modules — except the
    // `_route` layout convention, resolved downstream by buildRouteTree.
    if (base.startsWith("_") && base !== "_route") {
      continue;
    }
    files.push({
      base,
      directorySegments,
      sourcePath,
    });
  }
}

function segmentPath(segment: string): string {
  return routeSegmentToPattern(segment);
}

function routePath(segments: string[]): string {
  return segments.length === 0 ? "/" : `/${segments.map(segmentPath).join("/")}`;
}

function routeId(instanceId: string, path: string): string {
  const encodedPath = Array.from(new TextEncoder().encode(path), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return `_route_${instanceId}_${encodedPath}`;
}

function buildRouteTree(pagesDir: string, instanceId: string): RouteTreeNode {
  const scannedFiles: ScannedRouteFile[] = [];
  scanRouteFiles(pagesDir, [], scannedFiles);
  const nodes = new Map<string, RouteTreeNode>();

  const ensureNode = (segments: string[]): RouteTreeNode => {
    const key = segments.join("/");
    const existing = nodes.get(key);
    if (existing) {
      return existing;
    }
    const node: RouteTreeNode = {
      children: [],
      fileRoutes: [],
      indexRoute: undefined,
      layout: undefined,
      name: segments.at(-1) ?? "",
    };
    nodes.set(key, node);
    if (segments.length > 0) {
      ensureNode(segments.slice(0, -1)).children.push(node);
    }
    return node;
  };
  const root = ensureNode([]);

  for (const file of scannedFiles) {
    const node = ensureNode(file.directorySegments);
    if (file.base === "_route") {
      const path = `${routePath(file.directorySegments)}#layout`;
      node.layout = { id: routeId(instanceId, path), path: "", sourcePath: file.sourcePath };
      continue;
    }
    const path =
      file.base === "index"
        ? routePath(file.directorySegments)
        : routePath([...file.directorySegments, file.base]);
    const route = { id: routeId(instanceId, path), path, sourcePath: file.sourcePath };
    if (file.base === "index") {
      node.indexRoute = route;
    } else {
      node.fileRoutes.push(route);
    }
  }
  return root;
}

function collectRouteFiles(root: RouteTreeNode): RouteFile[] {
  const files: RouteFile[] = [];
  const nodes = [root];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) {
      continue;
    }
    if (node.layout) {
      files.push(node.layout);
    }
    if (node.indexRoute) {
      files.push(node.indexRoute);
    }
    files.push(...node.fileRoutes);
    nodes.push(...node.children);
  }
  return files;
}

export function routeSourcePaths(instance: RouteInstanceSpec): string[] {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  return collectRouteFiles(buildRouteTree(instance.pagesDir, instanceId))
    .map(({ sourcePath }) => resolve(sourcePath))
    .toSorted((left, right) => left.localeCompare(right));
}

function conventionSourcePaths(directory: string): string[] {
  const paths: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!entry.name.startsWith("_")) {
        paths.push(...conventionSourcePaths(join(directory, entry.name)));
      }
      continue;
    }
    const extension = extname(entry.name);
    if (!ROUTE_EXTENSION.test(extension) || entry.name.endsWith(".d.ts")) {
      continue;
    }
    const base = entry.name.slice(0, -extension.length);
    if (base === "error" || base === "not-found") {
      paths.push(resolve(directory, entry.name));
    }
  }
  return paths;
}

function routeSnapshotSourcePaths(instance: RouteInstanceSpec): string[] {
  const rootPath = resolve(instance.pagesDir, "root.tsx");
  return [
    ...(existsSync(rootPath) ? [rootPath] : []),
    ...routeSourcePaths(instance),
    ...conventionSourcePaths(instance.pagesDir),
  ].toSorted((left, right) => left.localeCompare(right));
}

function routeTopologySource(instance: RouteInstanceSpec): string {
  const pagesDir = resolve(instance.pagesDir);
  const paths = routeSnapshotSourcePaths(instance).map((path) =>
    relative(pagesDir, path).replaceAll("\\", "/")
  );
  return `${JSON.stringify(paths)}\n`;
}

function routeFilesSignature(instance: RouteInstanceSpec): string {
  const dependencyPaths = new Set<string>();
  for (const sourcePath of routeSnapshotSourcePaths(instance)) {
    const cached = routeModuleCache().get(sourcePath);
    const dependencies = cached?.dependencies ?? collectRouteModuleDependencies(sourcePath);
    for (const dependency of dependencies) {
      dependencyPaths.add(dependency.path);
    }
  }
  return [...dependencyPaths]
    .toSorted((left, right) => left.localeCompare(right))
    .map((path) => {
      try {
        return `${path}:${statSync(path).mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join("\n");
}

function devRouteTopologyWatchers(): Map<string, DevRouteTopologyWatcherState> {
  const existing = Reflect.get(globalThis, DEV_ROUTE_WATCHERS_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<string, DevRouteTopologyWatcherState>;
  }
  const watchers = new Map<string, DevRouteTopologyWatcherState>();
  Reflect.set(globalThis, DEV_ROUTE_WATCHERS_SYMBOL, watchers);
  return watchers;
}

async function refreshRouteTopology(state: DevRouteTopologyWatcherState): Promise<void> {
  if (state.refreshing) {
    state.pending = true;
    return;
  }
  state.refreshing = true;
  try {
    state.pending = false;
    const source = routeTopologySource(state.instance);
    if (source === state.source) {
      const signature = routeFilesSignature(state.instance);
      if (signature !== state.routeFilesSignature) {
        await state.onRouteFilesTouched?.();
        state.routeFilesSignature = routeFilesSignature(state.instance);
      }
    } else {
      await state.onTopologyChange();
      state.source = routeTopologySource(state.instance);
      state.routeFilesSignature = routeFilesSignature(state.instance);
    }
  } catch (error) {
    console.error("[furin] Failed to refresh route topology", error);
  } finally {
    state.refreshing = false;
    if (state.pending) {
      await refreshRouteTopology(state);
    }
  }
}

export function registerDevRouteTopologyWatcher(
  options: DevRouteTopologyWatcherOptions
): DevRouteTopologyWatcher {
  const watcherKey = instanceKey(options.instance);
  const watchers = devRouteTopologyWatchers();
  const existing = watchers.get(watcherKey);
  if (existing) {
    existing.instance = options.instance;
    existing.onRouteFilesTouched = options.onRouteFilesTouched;
    existing.onTopologyChange = options.onTopologyChange;
    return {
      close: () => {
        clearInterval(existing.timer);
        watchers.delete(watcherKey);
      },
    };
  }

  const source = routeTopologySource(options.instance);
  const routeFilesSignatureValue = routeFilesSignature(options.instance);
  let state: DevRouteTopologyWatcherState;
  const timer = setInterval(() => {
    refreshRouteTopology(state).catch((error) => {
      console.error("[furin] Failed to poll route topology", error);
    });
  }, options.pollIntervalMs);
  timer.unref();
  state = {
    ...options,
    pending: false,
    refreshing: false,
    routeFilesSignature: routeFilesSignatureValue,
    source,
    timer,
  };
  watchers.set(watcherKey, state);

  return {
    close: () => {
      clearInterval(timer);
      watchers.delete(watcherKey);
    },
  };
}

function emitRouteNode(node: RouteTreeNode, indentation: string): string {
  const childIndentation = `${indentation}  `;
  const prefix = node.name ? `/${segmentPath(node.name)}` : "";
  const head = `new Elysia({ prefix: ${JSON.stringify(prefix)} })`;
  const content: string[] = [];
  if (node.indexRoute) {
    content.push(
      `${childIndentation}.use(new Elysia({ prefix: "" }).use(${node.indexRoute.id}.elysia))`
    );
  }
  for (const route of node.fileRoutes) {
    const segment = route.path.slice(route.path.lastIndexOf("/") + 1);
    content.push(
      `${childIndentation}.use(new Elysia({ prefix: ${JSON.stringify(`/${segment}`)} }).use(${route.id}.elysia))`
    );
  }
  for (const child of node.children) {
    content.push(`${childIndentation}.use(`);
    content.push(emitRouteNode(child, `${childIndentation}  `));
    content.push(`${childIndentation})`);
  }
  if (node.layout) {
    return [
      `${head}.use(`,
      `${childIndentation}${node.layout.id}.elysia`,
      ...content.map((line) => `  ${line}`),
      `${childIndentation})`,
    ].join("\n");
  }
  return [head, ...content].join("\n");
}

interface GeneratedServerInstance {
  appExpression: string;
  exportName: string;
  imports: string;
}

interface RouteModuleInfo {
  routePath: string;
  sourcePath: string;
}

function routeFileSpecifier(route: RouteFile): string {
  return `furin-route-file:${route.id}`;
}

async function retainComposableRoutes(node: RouteTreeNode): Promise<void> {
  const isComposable = async (route: RouteFile): Promise<boolean> => {
    const module = await loadRouteModule(route.sourcePath);
    return typeof module.route?.elysia === "object" && module.route.elysia !== null;
  };

  if (node.layout && !(await isComposable(node.layout))) {
    node.layout = undefined;
  }
  if (node.indexRoute && !(await isComposable(node.indexRoute))) {
    node.indexRoute = undefined;
  }
  const composableRoutes = (
    await Promise.all(
      node.fileRoutes.map(async (route) => ({ keep: await isComposable(route), route }))
    )
  ).flatMap(({ keep, route }) => (keep ? [route] : []));
  node.fileRoutes = composableRoutes;
  await Promise.all(node.children.map((child) => retainComposableRoutes(child)));
}

async function generateServerInstance(
  instance: RouteInstanceSpec,
  routeFilesBySpecifier: Map<string, RouteModuleInfo>
): Promise<GeneratedServerInstance> {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  const tree = buildRouteTree(instance.pagesDir, instanceId);
  await retainComposableRoutes(tree);
  const imports = collectRouteFiles(tree)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
    .map((route) => {
      const specifier = routeFileSpecifier(route);
      routeFilesBySpecifier.set(specifier, {
        routePath: route.path,
        sourcePath: resolve(route.sourcePath),
      });
      return `import { route as ${route.id} } from ${JSON.stringify(specifier)};`;
    })
    .join("\n");
  return {
    appExpression: emitRouteNode(tree, ""),
    exportName: `furinApp_${instanceId}`,
    imports,
  };
}

async function serverRegistrySource(
  instances: RouteInstanceSpec[],
  routeFilesBySpecifier: Map<string, RouteModuleInfo>
): Promise<string> {
  routeFilesBySpecifier.clear();
  const generated = await Promise.all(
    instances.map((instance) => generateServerInstance(instance, routeFilesBySpecifier))
  );
  return `import { Elysia } from "elysia";
${generated.map(({ imports }) => imports).join("\n")}

${generated
  .map(({ appExpression, exportName }) => `export const ${exportName} = ${appExpression};`)
  .join("\n")}
`;
}

export function validateRouteParams(
  path: string,
  schemas: { params?: { properties?: object } } | undefined
): void {
  const pathParams = path
    .split("/")
    .filter((segment) => segment === "*" || segment.startsWith(":"))
    .map((segment) => (segment === "*" ? segment : segment.slice(1)));
  if (pathParams.length === 0) {
    return;
  }
  const schemaParams = new Set(
    schemas?.params?.properties ? Object.keys(schemas.params.properties) : []
  );
  const missing = pathParams.filter((param) => !schemaParams.has(param));
  if (missing.length > 0) {
    throw new Error(
      `[furin] ${JSON.stringify(path)}: path params missing from the params schema: ${missing.join(", ")}`
    );
  }
}

const ROUTE_MODULE_CACHE_SYMBOL = Symbol.for("@teyik0/furin/route-module-cache");

interface CachedRouteModule {
  dependencies: RouteModuleDependency[];
  module: Record<string, unknown>;
}

interface RouteModuleDependency {
  mtimeMs: number;
  path: string;
}

/**
 * TanStack-style incremental generator cache: a route module is re-evaluated
 * only when it or one of its transitive project-local imports changed.
 * Unchanged modules remain cached, so topology scans avoid rebuilding every
 * composed Elysia route. The cache lives on globalThis across Bun soft reloads;
 * dependency mtimes make stale closures self-heal on the next scan.
 */
function routeModuleCache(): Map<string, CachedRouteModule> {
  const existing = Reflect.get(globalThis, ROUTE_MODULE_CACHE_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<string, CachedRouteModule>;
  }
  const cache = new Map<string, CachedRouteModule>();
  Reflect.set(globalThis, ROUTE_MODULE_CACHE_SYMBOL, cache);
  return cache;
}

function findPackageRoot(sourcePath: string): string {
  const fallback = dirname(sourcePath);
  let directory = fallback;
  while (dirname(directory) !== directory) {
    if (existsSync(join(directory, "package.json"))) {
      return directory;
    }
    directory = dirname(directory);
  }
  return existsSync(join(directory, "package.json")) ? directory : fallback;
}

function isWithinDirectory(path: string, directory: string): boolean {
  const relativePath = relative(directory, path);
  return relativePath === "" || !(relativePath.startsWith("..") || isAbsolute(relativePath));
}

function isFurinPackageImport(specifier: string): boolean {
  return (
    specifier === "furin" ||
    specifier.startsWith("furin/") ||
    specifier === "@teyik0/furin" ||
    specifier.startsWith("@teyik0/furin/")
  );
}

function resolveRouteModuleImports(dependencyPath: string, packageRoot: string): string[] {
  if (!ROUTE_EXTENSION.test(extname(dependencyPath))) {
    return [];
  }
  const source = readFileSync(dependencyPath, "utf8");
  const transpiler = new Bun.Transpiler({ loader: detectLoaderFromPath(dependencyPath) });
  const resolvedImports: string[] = [];
  for (const imported of transpiler.scanImports(source)) {
    if (isFurinPackageImport(imported.path)) {
      continue;
    }
    try {
      const resolvedImport = realpathSync(Bun.resolveSync(imported.path, dirname(dependencyPath)));
      if (isAbsolute(resolvedImport) && isWithinDirectory(resolvedImport, packageRoot)) {
        resolvedImports.push(resolvedImport);
      }
    } catch {
      // External and unresolved imports do not participate in the local graph.
    }
  }
  return resolvedImports;
}

function collectRouteModuleDependencies(sourcePath: string): RouteModuleDependency[] {
  const packageRoot = realpathSync(findPackageRoot(sourcePath));
  const pending = [sourcePath];
  const visited = new Set<string>();
  const dependencies: RouteModuleDependency[] = [];

  while (pending.length > 0) {
    const dependencyPath = pending.pop();
    if (!dependencyPath || visited.has(dependencyPath)) {
      continue;
    }
    visited.add(dependencyPath);

    let mtimeMs: number;
    try {
      ({ mtimeMs } = statSync(dependencyPath));
    } catch {
      continue;
    }
    dependencies.push({ mtimeMs, path: dependencyPath });
    pending.push(...resolveRouteModuleImports(dependencyPath, packageRoot));
  }

  return dependencies.toSorted((left, right) => left.path.localeCompare(right.path));
}

function routeModuleDependenciesAreFresh(dependencies: RouteModuleDependency[]): boolean {
  return dependencies.every((dependency) => {
    try {
      return statSync(dependency.path).mtimeMs === dependency.mtimeMs;
    } catch {
      return false;
    }
  });
}

async function importRouteModule(sourcePath: string): Promise<Record<string, unknown>> {
  const cache = routeModuleCache();
  const cached = cache.get(sourcePath);
  if (
    cached &&
    Array.isArray(cached.dependencies) &&
    routeModuleDependenciesAreFresh(cached.dependencies)
  ) {
    return cached.module;
  }
  const dependencies = collectRouteModuleDependencies(sourcePath);
  const fingerprint = Bun.hash(JSON.stringify(dependencies)).toString(16);
  const moduleUrl = `${pathToFileURL(sourcePath).href}?furin-routes=${fingerprint}`;
  const module = (await import(moduleUrl)) as Record<string, unknown>;
  cache.set(sourcePath, { dependencies, module });
  return module;
}

async function validateRouteModules(routeFiles: Iterable<RouteModuleInfo>): Promise<void> {
  const validations: Promise<void>[] = [];
  for (const routeFile of routeFiles) {
    if (routeFile.routePath === "") {
      continue;
    }
    validations.push(
      (async () => {
        const module = (await importRouteModule(routeFile.sourcePath)) as {
          route?: { schemas?: { params?: { properties?: object } } };
        };
        validateRouteParams(routeFile.routePath, module.route?.schemas);
      })()
    );
  }
  await Promise.all(validations);
}

interface ClientRouteMetadata {
  hasLoader: boolean;
  mode: string;
  pattern: string;
}

async function loadRouteModule(sourcePath: string): Promise<{
  route?: {
    elysia?: AnyElysia;
    loader?: unknown;
    mode?: string;
    schemas?: { params?: { properties?: object } };
    useLoaderData?: () => unknown;
  };
}> {
  return (await importRouteModule(sourcePath)) as {
    route?: {
      elysia?: AnyElysia;
      loader?: unknown;
      mode?: string;
      schemas?: { params?: { properties?: object } };
      useLoaderData?: () => unknown;
    };
  };
}

async function composableRouteApps(route: RouteFile): Promise<DevRoutesApps | undefined> {
  const module = await loadRouteModule(route.sourcePath);
  if (!module.route?.elysia) {
    return;
  }
  if (route.path !== "") {
    validateRouteParams(route.path, module.route.schemas);
  }
  return {
    app: module.route.elysia,
    shell:
      route.path === ""
        ? new Elysia()
        : new Elysia().get("/", (context) => {
            const renderer = getFurinRenderer(context);
            if (!renderer) {
              throw new Error("[furin] No route renderer is registered.");
            }
            return renderer(context as unknown as FurinNativeRouteContext);
          }),
  };
}

async function composeRuntimeNode(node: RouteTreeNode): Promise<DevRoutesApps> {
  const prefix = node.name ? `/${segmentPath(node.name)}` : "";
  const [layoutApps, indexRouteApps, fileRouteApps, childApps] = await Promise.all([
    node.layout ? composableRouteApps(node.layout) : undefined,
    node.indexRoute ? composableRouteApps(node.indexRoute) : undefined,
    Promise.all(node.fileRoutes.map((route) => composableRouteApps(route))),
    Promise.all(node.children.map((child) => composeRuntimeNode(child))),
  ]);
  const appScope = layoutApps?.app ?? new Elysia();
  const shellScope = layoutApps?.shell ?? new Elysia();

  if (indexRouteApps) {
    appScope.use(new Elysia({ prefix: "" }).use(indexRouteApps.app));
    shellScope.use(new Elysia({ prefix: "" }).use(indexRouteApps.shell));
  }
  for (const [index, route] of node.fileRoutes.entries()) {
    const routeApps = fileRouteApps[index];
    if (routeApps) {
      const segment = route.path.slice(route.path.lastIndexOf("/") + 1);
      appScope.use(new Elysia({ prefix: `/${segment}` }).use(routeApps.app));
      shellScope.use(new Elysia({ prefix: `/${segment}` }).use(routeApps.shell));
    }
  }
  for (const child of childApps) {
    appScope.use(child.app);
    shellScope.use(child.shell);
  }

  return {
    app: new Elysia({ prefix }).use(appScope),
    shell: new Elysia({ prefix }).use(shellScope),
  };
}

function composeRuntimeInstance(instance: RouteInstanceSpec): Promise<DevRoutesApps> {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  return composeRuntimeNode(buildRouteTree(instance.pagesDir, instanceId));
}

function devRoutesApps(): Map<string, DevRoutesApps> {
  const existing = Reflect.get(globalThis, DEV_ROUTES_APPS_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<string, DevRoutesApps>;
  }
  const apps = new Map<string, DevRoutesApps>();
  Reflect.set(globalThis, DEV_ROUTES_APPS_SYMBOL, apps);
  return apps;
}

export function registerDevRoutesPlugin(instances: RouteInstanceSpec[]): void {
  for (const instance of instances) {
    devInstancesBySpecifier.set(routeModuleSpecifier(instance), instance);
  }
  if (devRoutesPluginRegistered) {
    return;
  }
  devRoutesPluginRegistered = true;

  Bun.plugin({
    name: "furin-routes-dev",
    setup(build) {
      build.onLoad({ filter: DEV_ROUTES_FILE_FILTER }, async ({ path }) => {
        const queryIndex = path.indexOf("?instance=");
        const specifier = `@teyik0/furin/routes${path.slice(queryIndex)}`;
        const instance = devInstancesBySpecifier.get(specifier);
        if (!instance) {
          throw new Error(`[furin] Unknown dev route instance: ${specifier}`);
        }
        devRoutesApps().set(specifier, await composeRuntimeInstance(instance));
        return {
          contents: `const registry = Reflect.get(globalThis, Symbol.for(${JSON.stringify(
            Symbol.keyFor(DEV_ROUTES_APPS_SYMBOL)
          )}));\nconst routes = registry.get(${JSON.stringify(
            specifier
          )});\nexport const furinApp = routes.app;\nexport const furinShell = routes.shell;\n`,
          loader: "js",
        };
      });
    },
  });
}

async function clientRoutesSource(instance: RouteInstanceSpec): Promise<string> {
  const tree = buildRouteTree(instance.pagesDir, Bun.hash(instanceKey(instance)).toString(16));
  const routes = collectRouteFiles(tree)
    .filter((route) => route.path !== "")
    .sort((left, right) => left.path.localeCompare(right.path));
  const metadata = await Promise.all(
    routes.map(async (routeFile): Promise<ClientRouteMetadata> => {
      const module = await loadRouteModule(routeFile.sourcePath);
      validateRouteParams(routeFile.path, module.route?.schemas);
      return {
        hasLoader: module.route?.loader !== undefined || module.route?.useLoaderData !== undefined,
        mode: module.route?.mode ?? "ssr",
        pattern: routeFile.path,
      };
    })
  );
  return `export const routes = ${JSON.stringify(metadata)};\n`;
}

function primaryInstance(instances: RouteInstanceSpec[]): RouteInstanceSpec {
  const instance = instances.find(({ prefix }) => prefix === "") ?? instances[0];
  if (!instance) {
    throw new Error("[furin] The routes plugin requires at least one instance");
  }
  return instance;
}

function serverProxySource(instance: RouteInstanceSpec): string {
  const exportName = `furinApp_${Bun.hash(instanceKey(instance)).toString(16)}`;
  return `export { ${exportName} as furinApp } from ${JSON.stringify(ROUTES_REGISTRY_SPECIFIER)};\n`;
}

export function createRoutesPlugin(options: CreateRoutesPluginOptions): Bun.BunPlugin {
  const routeFilesBySpecifier = new Map<string, RouteModuleInfo>();
  const routeFilesByResolvedPath = new Map<string, RouteModuleInfo>();
  const registryVirtualPath = join(
    resolve(primaryInstance(options.instances).pagesDir),
    ".furin-routes-registry.ts?furin-virtual"
  );
  const instancesBySpecifier = new Map(
    options.instances.map(
      (instance) =>
        [
          routeModuleSpecifier(instance),
          { instance, namespace: instanceNamespace(instance) },
        ] as const
    )
  );

  return {
    name: `furin-routes-${options.target}`,
    setup(build) {
      if (options.target === "client") {
        const instance = primaryInstance(options.instances);
        build.onResolve({ filter: CLIENT_ROUTES_FILTER }, () => ({
          namespace: CLIENT_ROUTES_NAMESPACE,
          path: "@teyik0/furin/routes",
        }));
        build.onLoad(
          { filter: VIRTUAL_ROUTES_FILTER, namespace: CLIENT_ROUTES_NAMESPACE },
          async () => ({ contents: await clientRoutesSource(instance), loader: "js" })
        );
        return;
      }
      build.onResolve({ filter: SERVER_ROUTES_FILTER }, ({ path }) => {
        const registered = instancesBySpecifier.get(path);
        if (!registered) {
          throw new Error(`[furin] Unknown route instance: ${path}`);
        }
        return { namespace: registered.namespace, path };
      });
      build.onResolve({ filter: ROUTES_REGISTRY_FILTER }, () => ({
        namespace: "file",
        path: registryVirtualPath,
      }));
      build.onLoad({ filter: ROUTES_REGISTRY_FILE_FILTER, namespace: "file" }, async () => {
        const contents = await serverRegistrySource(options.instances, routeFilesBySpecifier);
        await validateRouteModules(routeFilesBySpecifier.values());
        return { contents, loader: "ts" };
      });
      build.onResolve({ filter: ROUTE_FILE_FILTER }, ({ path }) => {
        const routeFile = routeFilesBySpecifier.get(path);
        if (!routeFile) {
          throw new Error(`[furin] Unknown route module: ${path}`);
        }
        const resolvedPath = routeFile.sourcePath;
        routeFilesByResolvedPath.set(resolvedPath, routeFile);
        return { namespace: ROUTE_FILES_NAMESPACE, path: resolvedPath };
      });
      build.onLoad(
        { filter: VIRTUAL_ROUTES_FILTER, namespace: ROUTE_FILES_NAMESPACE },
        async ({ path }) => {
          const routeFile = routeFilesByResolvedPath.get(path);
          if (!routeFile) {
            throw new Error(`[furin] Unknown route module: ${path}`);
          }
          return {
            contents: await Bun.file(routeFile.sourcePath).text(),
            loader: detectLoaderFromPath(routeFile.sourcePath),
            resolveDir: dirname(routeFile.sourcePath),
          };
        }
      );
      for (const { instance, namespace } of instancesBySpecifier.values()) {
        build.onLoad({ filter: VIRTUAL_ROUTES_FILTER, namespace }, () => ({
          contents: serverProxySource(instance),
          loader: "ts",
        }));
      }
    },
  };
}
