import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyElysia } from "elysia";
import type { CompiledModule } from "../server/internal.ts";
import { detectLoaderFromPath, SCRIPT_FILE_FILTER } from "../server/lang-detect.ts";

const ROUTE_MODULE_CACHE_SYMBOL = Symbol.for("@teyik0/furin/route-module-cache");

export interface RouteModuleInfo {
  routePath: string;
  sourcePath: string;
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

/** The fields of a `defineRoute()` export the routes plugin reads. */
interface RouteExport {
  elysia?: AnyElysia;
  loader?: unknown;
  mode?: string;
  schemas?: { params?: { properties?: object } };
}

/** Namespace of an imported page or layout module. */
export interface RouteModule extends CompiledModule {
  readonly route?: RouteExport;
}

interface CachedRouteModule {
  dependencies: RouteModuleDependency[];
  module: RouteModule;
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
  if (!SCRIPT_FILE_FILTER.test(dependencyPath)) {
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
      const resolvedImport = realpathSync.native(
        Bun.resolveSync(imported.path, dirname(dependencyPath))
      );
      if (
        isAbsolute(resolvedImport) &&
        isWithinDirectory(resolvedImport, packageRoot) &&
        // Each import has its own path segments; constructing a Set adds no reusable lookup.
        // react-doctor-disable-next-line react-doctor/js-set-map-lookups
        !relative(packageRoot, resolvedImport).split(sep).includes("node_modules")
      ) {
        resolvedImports.push(resolvedImport);
      }
    } catch {
      // External and unresolved imports do not participate in the local graph.
    }
  }
  return resolvedImports;
}

function collectRouteModuleDependencies(sourcePath: string): RouteModuleDependency[] {
  const packageRoot = realpathSync.native(findPackageRoot(sourcePath));
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

/** Project-local files a route module depends on, cached once the module is loaded. */
export function routeModuleDependencies(sourcePath: string): RouteModuleDependency[] {
  return (
    routeModuleCache().get(sourcePath)?.dependencies ?? collectRouteModuleDependencies(sourcePath)
  );
}

export async function loadRouteModule(sourcePath: string): Promise<RouteModule> {
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
  const module: RouteModule = await import(moduleUrl);
  cache.set(sourcePath, { dependencies, module });
  return module;
}

export async function validateRouteModules(routeFiles: Iterable<RouteModuleInfo>): Promise<void> {
  const validations: Promise<void>[] = [];
  for (const routeFile of routeFiles) {
    if (routeFile.routePath === "") {
      continue;
    }
    validations.push(
      (async () => {
        const module = await loadRouteModule(routeFile.sourcePath);
        validateRouteParams(routeFile.routePath, module.route?.schemas);
      })()
    );
  }
  await Promise.all(validations);
}
