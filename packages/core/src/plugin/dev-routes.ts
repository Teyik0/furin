import { existsSync, type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import { type FurinNativeRouteContext, getFurinRenderer } from "../define-route.ts";
import { detectLoaderFromPath, SCRIPT_FILE_FILTER } from "../server/lang-detect.ts";
import { isRouteGroup } from "../server/router/patterns.ts";
import { routeModuleSourceVersion } from "../server/router/source-version.ts";
import { type RouteModule, routeModuleDependencies, validateRouteParams } from "./route-modules.ts";
import {
  buildRouteTree,
  instanceKey,
  type RouteFile,
  type RouteInstanceSpec,
  type RouteTreeNode,
  routeModuleSpecifier,
  routeSnapshotSourcePaths,
  segmentPath,
} from "./route-tree.ts";

const DEV_ROUTES_APPS_SYMBOL = Symbol.for("@teyik0/furin/dev-routes-apps");
const DEV_ROUTE_WATCHERS_SYMBOL = Symbol.for("@teyik0/furin/dev-route-watchers");
const DEV_ROUTE_WATCHER_OWNERS_SYMBOL = Symbol.for("@teyik0/furin/dev-route-watcher-owners");
const DEV_ROUTES_FILE_FILTER = /[\\/]routes\.ts\?instance=[^&]+$/;
const DEV_ROUTE_RECONCILE_DELAY_MS = 25;
const DEV_ROUTE_RETRY_DELAY_MS = 100;
const devInstancesBySpecifier = new Map<string, RouteInstanceSpec>();
let devRoutesPluginRegistered = false;

interface DevRoutesApps {
  app: AnyElysia;
  shell: AnyElysia;
}

export interface DevRouteTopologyWatcher {
  close: () => void;
  refresh: () => Promise<void>;
}

export interface DevRouteTopologyWatcherOptions {
  instance: RouteInstanceSpec;
  onRouteFilesTouched?: (sourcePaths: readonly string[]) => Promise<void> | void;
  onSourceError?: (error: unknown, sourcePath: string) => void;
  onTopologyChange: (sourcePaths: readonly string[]) => Promise<void> | void;
  owner?: { app: object; prefix: string };
}

interface DevRouteTopologyWatcherState extends DevRouteTopologyWatcherOptions {
  changedSources: Set<string>;
  closed: boolean;
  dirty: boolean;
  pending: boolean;
  reconcileTimer: ReturnType<typeof setTimeout> | undefined;
  refreshPromise: Promise<void> | undefined;
  registration: object;
  routeFilesSignature: string;
  source: string;
  watchers: FSWatcher[];
}

function routeTopologySource(instance: RouteInstanceSpec): string {
  const pagesDir = resolve(instance.pagesDir);
  const paths = routeSnapshotSourcePaths(instance).map((path) =>
    relative(pagesDir, path).replaceAll("\\", "/")
  );
  return `${JSON.stringify(paths)}\n`;
}

function routeDependencyPaths(instance: RouteInstanceSpec): string[] {
  const dependencyPaths = new Set<string>();
  for (const sourcePath of routeSnapshotSourcePaths(instance)) {
    for (const dependency of routeModuleDependencies(sourcePath)) {
      dependencyPaths.add(dependency.path);
    }
  }
  return [...dependencyPaths].toSorted((left, right) => left.localeCompare(right));
}

function routeFilesSignature(instance: RouteInstanceSpec): string {
  return routeDependencyPaths(instance)
    .map((path) => {
      try {
        const stats = statSync(path, { bigint: true });
        return `${path}\0${stats.mtimeNs}:${stats.size}`;
      } catch {
        return `${path}\0missing`;
      }
    })
    .join("\n");
}

function changedSignaturePaths(previous: string, next: string): string[] {
  const entries = (signature: string): Map<string, string> =>
    new Map(
      signature
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const separator = line.indexOf("\0");
          return [line.slice(0, separator), line.slice(separator + 1)];
        })
    );
  const previousEntries = entries(previous);
  const nextEntries = entries(next);
  return [...new Set([...previousEntries.keys(), ...nextEntries.keys()])].filter(
    (path) => previousEntries.get(path) !== nextEntries.get(path)
  );
}

function devRouteTopologyWatchers(): Map<RouteInstanceSpec, DevRouteTopologyWatcherState> {
  const existing = Reflect.get(globalThis, DEV_ROUTE_WATCHERS_SYMBOL);
  if (existing instanceof Map) {
    return existing as Map<RouteInstanceSpec, DevRouteTopologyWatcherState>;
  }
  const watchers = new Map<RouteInstanceSpec, DevRouteTopologyWatcherState>();
  Reflect.set(globalThis, DEV_ROUTE_WATCHERS_SYMBOL, watchers);
  return watchers;
}

function watcherChangedSources(state: DevRouteTopologyWatcherState): Set<string> {
  const existing = Reflect.get(state, "changedSources");
  if (existing instanceof Set) {
    return existing as Set<string>;
  }
  const changedSources = new Set<string>();
  state.changedSources = changedSources;
  return changedSources;
}

async function refreshRouteTopologyOnce(state: DevRouteTopologyWatcherState): Promise<void> {
  const pendingChangedSources = watcherChangedSources(state);
  let changedSources = [...pendingChangedSources];
  pendingChangedSources.clear();
  try {
    state.dirty = false;
    const source = routeTopologySource(state.instance);
    if (source === state.source) {
      const signature = routeFilesSignature(state.instance);
      if (signature !== state.routeFilesSignature) {
        changedSources = [
          ...new Set([
            ...changedSources,
            ...changedSignaturePaths(state.routeFilesSignature, signature),
          ]),
        ];
        await state.onRouteFilesTouched?.(changedSources);
        // The signature read before the callback: a save that lands while it
        // runs must trigger another refresh.
        state.routeFilesSignature = signature;
        if (!state.closed) {
          replaceSourceWatchers(state);
        }
      }
    } else {
      await state.onTopologyChange(changedSources);
      state.source = routeTopologySource(state.instance);
      state.routeFilesSignature = routeFilesSignature(state.instance);
      if (!state.closed) {
        replaceSourceWatchers(state);
      }
    }
  } catch (error) {
    console.error("[furin] Failed to refresh route topology", error);
    state.dirty = true;
    for (const sourcePath of changedSources) {
      pendingChangedSources.add(sourcePath);
    }
    scheduleRouteTopologyRefresh(state, DEV_ROUTE_RETRY_DELAY_MS);
  }
}

function scheduleRouteTopologyRefresh(state: DevRouteTopologyWatcherState, delay: number): void {
  if (state.closed || state.reconcileTimer !== undefined) {
    return;
  }
  state.reconcileTimer = setTimeout(() => {
    state.reconcileTimer = undefined;
    refreshRouteTopology(state).catch((error) => {
      console.error("[furin] Failed to reconcile route topology", error);
    });
  }, delay);
  state.reconcileTimer.unref();
}

function reportChangedSourceError(
  state: DevRouteTopologyWatcherState,
  directory: string,
  filename: string | Buffer | null
): void {
  if (filename === null) {
    return;
  }
  const sourcePath = resolve(directory, String(filename));
  if (!(SCRIPT_FILE_FILTER.test(sourcePath) && existsSync(sourcePath))) {
    return;
  }
  try {
    const source = readFileSync(sourcePath, "utf8");
    const loader = detectLoaderFromPath(sourcePath);
    new Bun.Transpiler({ loader }).transformSync(source, loader);
  } catch (error) {
    state.onSourceError?.(error, sourcePath);
  }
}

function replaceSourceWatchers(state: DevRouteTopologyWatcherState): void {
  const previousWatchers = state.watchers;
  const nextWatchers: FSWatcher[] = [];
  const pagesDir = resolve(state.instance.pagesDir);
  const directories = new Set<string>();
  for (const path of routeDependencyPaths(state.instance)) {
    if (!(path === pagesDir || path.startsWith(`${pagesDir}${sep}`))) {
      directories.add(dirname(path));
    }
  }
  const watchDirectory = (directory: string, recursive: boolean): void => {
    const watcher = watch(directory, { recursive }, (_, filename) => {
      if (!state.watchers.includes(watcher)) {
        return;
      }
      state.dirty = true;
      if (filename !== null) {
        watcherChangedSources(state).add(resolve(directory, String(filename)));
      }
      reportChangedSourceError(state, directory, filename);
      scheduleRouteTopologyRefresh(state, DEV_ROUTE_RECONCILE_DELAY_MS);
    });
    watcher.unref();
    nextWatchers.push(watcher);
  };
  try {
    watchDirectory(pagesDir, true);
    for (const directory of directories) {
      watchDirectory(directory, false);
    }
  } catch (error) {
    for (const watcher of nextWatchers) {
      watcher.close();
    }
    throw error;
  }
  state.watchers = nextWatchers;
  for (const watcher of previousWatchers) {
    watcher.close();
  }
}

function refreshRouteTopology(state: DevRouteTopologyWatcherState): Promise<void> {
  if (state.closed) {
    return Promise.resolve();
  }
  state.pending = true;
  if (state.refreshPromise) {
    return state.refreshPromise;
  }

  state.refreshPromise = (async () => {
    try {
      while (state.pending && !state.closed) {
        state.pending = false;
        // biome-ignore lint/performance/noAwaitInLoops: refreshes must be serialized so requests observe the latest route snapshot
        await refreshRouteTopologyOnce(state);
      }
    } finally {
      state.refreshPromise = undefined;
    }
  })();
  return state.refreshPromise;
}

export function registerDevRouteTopologyWatcher(
  options: DevRouteTopologyWatcherOptions
): DevRouteTopologyWatcher {
  let watcherKey = options.instance;
  if (options.owner) {
    let owners = Reflect.get(globalThis, DEV_ROUTE_WATCHER_OWNERS_SYMBOL) as
      | WeakMap<object, Map<string, RouteInstanceSpec>>
      | undefined;
    if (!owners) {
      owners = new WeakMap();
      Reflect.set(globalThis, DEV_ROUTE_WATCHER_OWNERS_SYMBOL, owners);
    }
    let mounts = owners.get(options.owner.app);
    if (!mounts) {
      mounts = new Map();
      owners.set(options.owner.app, mounts);
    }
    watcherKey = mounts.get(options.owner.prefix) ?? options.instance;
    mounts.set(options.owner.prefix, watcherKey);
  }
  const watchers = devRouteTopologyWatchers();
  const existing = watchers.get(watcherKey);
  const registration = {};
  if (existing) {
    existing.instance = options.instance;
    existing.onRouteFilesTouched = options.onRouteFilesTouched;
    existing.onSourceError = options.onSourceError;
    existing.onTopologyChange = options.onTopologyChange;
    existing.registration = registration;
    replaceSourceWatchers(existing);
    return {
      close: () => {
        if (existing.registration !== registration) {
          return;
        }
        existing.closed = true;
        if (existing.reconcileTimer !== undefined) {
          clearTimeout(existing.reconcileTimer);
        }
        for (const watcher of existing.watchers) {
          watcher.close();
        }
        watchers.delete(watcherKey);
      },
      refresh: () => refreshRouteTopology(existing),
    };
  }

  const source = routeTopologySource(options.instance);
  const routeFilesSignatureValue = routeFilesSignature(options.instance);
  const state: DevRouteTopologyWatcherState = {
    ...options,
    changedSources: new Set(),
    closed: false,
    dirty: false,
    pending: false,
    reconcileTimer: undefined,
    refreshPromise: undefined,
    registration,
    routeFilesSignature: routeFilesSignatureValue,
    source,
    watchers: [],
  };
  replaceSourceWatchers(state);
  scheduleRouteTopologyRefresh(state, DEV_ROUTE_RECONCILE_DELAY_MS);
  watchers.set(watcherKey, state);

  return {
    close: () => {
      if (state.registration !== registration) {
        return;
      }
      state.closed = true;
      if (state.reconcileTimer !== undefined) {
        clearTimeout(state.reconcileTimer);
      }
      for (const watcher of state.watchers) {
        watcher.close();
      }
      watchers.delete(watcherKey);
    },
    refresh: () => refreshRouteTopology(state),
  };
}

async function composableRouteApps(route: RouteFile): Promise<DevRoutesApps | undefined> {
  const module: RouteModule = await import(
    `${route.sourcePath}?furin-server&t=${routeModuleSourceVersion(route.sourcePath)}`
  );
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
            return renderer(context as unknown as FurinNativeRouteContext, route.path);
          }),
  };
}

async function composeRuntimeNode(node: RouteTreeNode): Promise<DevRoutesApps> {
  const prefix = node.name && !isRouteGroup(node.name) ? `/${segmentPath(node.name)}` : "";
  const { fileRoutes } = node;
  const [layoutApps, indexRouteApps, fileRouteApps, childApps] = await Promise.all([
    node.layout ? composableRouteApps(node.layout) : undefined,
    node.indexRoute ? composableRouteApps(node.indexRoute) : undefined,
    Promise.all(fileRoutes.map((route) => composableRouteApps(route))),
    Promise.all(node.children.map((child) => composeRuntimeNode(child))),
  ]);
  const appScope = layoutApps?.app ?? new Elysia();
  const shellScope = layoutApps?.shell ?? new Elysia();

  if (indexRouteApps) {
    appScope.use(new Elysia({ prefix: "" }).use(indexRouteApps.app));
    shellScope.use(new Elysia({ prefix: "" }).use(indexRouteApps.shell));
  }
  for (const [index, route] of fileRoutes.entries()) {
    const routeApps = fileRouteApps[index];
    if (routeApps) {
      const segment = route.path.slice(route.path.lastIndexOf("/") + 1);
      appScope.use(new Elysia({ prefix: `/${segment}` }).use(routeApps.app));
      if (route.path !== "/*") {
        shellScope.use(new Elysia({ prefix: `/${segment}` }).use(routeApps.shell));
      }
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

async function composeRuntimeInstance(instance: RouteInstanceSpec): Promise<DevRoutesApps> {
  const { registerDevPagePlugin } = await import("../server/dev-page-plugin.ts");
  registerDevPagePlugin();
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
