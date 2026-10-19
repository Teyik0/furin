import { dirname, join, resolve } from "node:path";
import { detectLoaderFromPath } from "../server/lang-detect.ts";
import { isRouteGroup } from "../server/router/patterns.ts";
import {
  loadRouteModule,
  type RouteModuleInfo,
  validateRouteModules,
  validateRouteParams,
} from "./route-modules.ts";
import {
  buildRouteTree,
  collectRouteFiles,
  instanceKey,
  type RouteFile,
  type RouteInstanceSpec,
  type RouteTreeNode,
  segmentPath,
} from "./route-tree.ts";
import { routeModuleSpecifier } from "./routes.ts";

const ROUTES_NAMESPACE_PREFIX = "furin-routes";
const ROUTES_REGISTRY_SPECIFIER = "furin/routes?registry";
const COMPOSABLE_ROUTES_REGISTRY_SPECIFIER = "furin/routes?registry=composable";
const ROUTES_REGISTRY_FILTER = /^furin\/routes\?registry(?:=composable)?$/;
const ROUTE_FILE_FILTER = /^furin-route-file:.+$/;
const ROUTE_FILES_NAMESPACE = "furin-route-files";
const ROUTES_REGISTRY_FILE_FILTER =
  /[\\/]\.furin-routes-registry(?:-composable)?\.ts\?furin-virtual$/;
const CLIENT_ROUTES_NAMESPACE = "furin-routes-client";
const CLIENT_ROUTES_FILTER = /^(?:@teyik0\/furin|furin)\/routes$/;
const SERVER_ROUTES_FILTER = /^(?:@teyik0\/furin|furin)\/routes\?instance=.+$/;
const VIRTUAL_ROUTES_FILTER = /.*/;

export interface CreateRoutesPluginOptions {
  instances: RouteInstanceSpec[];
  target: "client" | "server";
}

export function composableRouteModuleSpecifier(instance: RouteInstanceSpec): string {
  return `${routeModuleSpecifier(instance)}&composable`;
}

function instanceNamespace(instance: RouteInstanceSpec): string {
  return `${ROUTES_NAMESPACE_PREFIX}-${Bun.hash(instanceKey(instance)).toString(16)}`;
}

function emitRouteNode(
  node: RouteTreeNode,
  indentation: string,
  includeRootCatchAll: boolean
): string {
  const childIndentation = `${indentation}  `;
  const prefix = node.name && !isRouteGroup(node.name) ? `/${segmentPath(node.name)}` : "";
  const head = `new Elysia({ prefix: ${JSON.stringify(prefix)} })`;
  const content: string[] = [];
  if (node.indexRoute) {
    content.push(
      `${childIndentation}.use(new Elysia({ prefix: "" }).use(${node.indexRoute.id}.elysia))`
    );
  }
  for (const route of node.fileRoutes.filter((file) => includeRootCatchAll || file.path !== "/*")) {
    const segment = route.path.slice(route.path.lastIndexOf("/") + 1);
    content.push(
      `${childIndentation}.use(new Elysia({ prefix: ${JSON.stringify(`/${segment}`)} }).use(${route.id}.elysia))`
    );
  }
  for (const child of node.children) {
    content.push(`${childIndentation}.use(`);
    content.push(emitRouteNode(child, `${childIndentation}  `, includeRootCatchAll));
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
  routeFilesBySpecifier: Map<string, RouteModuleInfo>,
  materialized: boolean,
  includeRootCatchAll: boolean
): Promise<GeneratedServerInstance> {
  const instanceId = Bun.hash(instanceKey(instance)).toString(16);
  const tree = buildRouteTree(instance.pagesDir, instanceId);
  await retainComposableRoutes(tree);
  const imports = collectRouteFiles(tree)
    .sort((left, right) => left.sourcePath.localeCompare(right.sourcePath))
    .map((route) => {
      const specifier = materialized
        ? resolve(route.sourcePath).replaceAll("\\", "/")
        : routeFileSpecifier(route);
      routeFilesBySpecifier.set(specifier, {
        routePath: route.path,
        sourcePath: resolve(route.sourcePath),
      });
      return `import { route as ${route.id} } from ${JSON.stringify(specifier)};`;
    })
    .join("\n");
  return {
    appExpression: emitRouteNode(tree, "", includeRootCatchAll),
    exportName: `furinApp_${instanceId}`,
    imports,
  };
}

async function serverRegistrySource(
  instances: RouteInstanceSpec[],
  routeFilesBySpecifier: Map<string, RouteModuleInfo>,
  materialized: boolean,
  includeRootCatchAll: boolean
): Promise<string> {
  routeFilesBySpecifier.clear();
  const generated = await Promise.all(
    instances.map((instance) =>
      generateServerInstance(instance, routeFilesBySpecifier, materialized, includeRootCatchAll)
    )
  );
  return `import { Elysia } from "elysia";
${generated.map(({ imports }) => imports).join("\n")}

${generated
  .map(({ appExpression, exportName }) => `export const ${exportName} = ${appExpression};`)
  .join("\n")}
`;
}

/**
 * Emits a real server route module for build-time consumers such as Elysia's
 * AOT plugin, which imports the application outside Bun's virtual module graph.
 */
export async function materializedRouteModuleSource(instance: RouteInstanceSpec): Promise<string> {
  const routeFilesBySpecifier = new Map<string, RouteModuleInfo>();
  const source = await serverRegistrySource([instance], routeFilesBySpecifier, true, false);
  await validateRouteModules(routeFilesBySpecifier.values());
  const exportName = `furinApp_${Bun.hash(instanceKey(instance)).toString(16)}`;
  return `${source}\nexport { ${exportName} as furinApp };\n`;
}

interface ClientRouteMetadata {
  hasLoader: boolean;
  mode: string;
  pattern: string;
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
        hasLoader: module.route?.loader !== undefined,
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

function serverProxySource(instance: RouteInstanceSpec, includeRootCatchAll: boolean): string {
  const exportName = `furinApp_${Bun.hash(instanceKey(instance)).toString(16)}`;
  const registry = includeRootCatchAll
    ? ROUTES_REGISTRY_SPECIFIER
    : COMPOSABLE_ROUTES_REGISTRY_SPECIFIER;
  return `export { ${exportName} as furinApp } from ${JSON.stringify(registry)};\n`;
}

export function createRoutesPlugin(options: CreateRoutesPluginOptions): Bun.BunPlugin {
  const routeFilesBySpecifier = new Map<string, RouteModuleInfo>();
  const routeFilesByResolvedPath = new Map<string, RouteModuleInfo>();
  const registryVirtualPath = join(
    resolve(primaryInstance(options.instances).pagesDir),
    ".furin-routes-registry.ts?furin-virtual"
  );
  const composableRegistryVirtualPath = join(
    resolve(primaryInstance(options.instances).pagesDir),
    ".furin-routes-registry-composable.ts?furin-virtual"
  );
  const instancesBySpecifier = new Map<
    string,
    { instance: RouteInstanceSpec; namespace: string; includeRootCatchAll: boolean }
  >(
    options.instances.flatMap((instance) => [
      [
        routeModuleSpecifier(instance),
        { includeRootCatchAll: true, instance, namespace: instanceNamespace(instance) },
      ] as const,
      [
        composableRouteModuleSpecifier(instance),
        {
          includeRootCatchAll: false,
          instance,
          namespace: `${instanceNamespace(instance)}-composable`,
        },
      ] as const,
    ])
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
      build.onResolve({ filter: ROUTES_REGISTRY_FILTER }, ({ path }) => ({
        namespace: "file",
        path:
          path === ROUTES_REGISTRY_SPECIFIER ? registryVirtualPath : composableRegistryVirtualPath,
      }));
      build.onLoad({ filter: ROUTES_REGISTRY_FILE_FILTER, namespace: "file" }, async ({ path }) => {
        const contents = await serverRegistrySource(
          options.instances,
          routeFilesBySpecifier,
          false,
          path === registryVirtualPath
        );
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
      for (const { instance, namespace, includeRootCatchAll } of instancesBySpecifier.values()) {
        build.onLoad({ filter: VIRTUAL_ROUTES_FILTER, namespace }, () => ({
          contents: serverProxySource(instance, includeRootCatchAll),
          loader: "ts",
        }));
      }
    },
  };
}
