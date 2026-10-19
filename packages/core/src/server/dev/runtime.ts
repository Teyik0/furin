import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { staticPlugin } from "@elysia/static";
import { type AnyElysia, Elysia, file } from "elysia";
import { prefixSlug } from "../../shared/prefix.ts";
import { invalidateDevLoaderCacheBySource } from "../cache/dev-loader.ts";
import { createInstrumentationPlugin } from "../devtools/instrumentation.ts";
import { type FurinInstance, withInstance } from "../instance.ts";
import type { ModeOptions, ModeRuntime } from "../mode.ts";
import { bindRuntimeRoutes, createRouteRenderer } from "../router/dispatch.ts";
import { developmentPagePorts, invalidateStampedRouteModules } from "../router/hmr.ts";
import { buildRouteMatcher } from "../router/patterns.ts";
import { createSearchRouteMetadata } from "../router/schemas.ts";
import type { ResolvedRoute, RootLayout } from "../router/types.ts";
import type { DevelopmentRouteSnapshot, DevGraph } from "./graph.ts";

function repairedDevelopmentRoutes(
  snapshot: DevelopmentRouteSnapshot,
  changedSources: readonly string[],
  graph: DevGraph<DevelopmentRouteSnapshot | null>
): { patterns: ReadonlySet<string>; root: boolean } {
  const patterns = new Set<string>();
  for (const route of snapshot.routes) {
    if (
      changedSources.some(
        (sourcePath) => route.path === sourcePath || graph.dependsOn(route.path, sourcePath)
      )
    ) {
      patterns.add(route.pattern);
    }
  }
  return {
    patterns,
    root: changedSources.some(
      (sourcePath) =>
        snapshot.root.path === sourcePath || graph.dependsOn(snapshot.root.path, sourcePath)
    ),
  };
}

type RouteHooks = AnyElysia["routes"][number]["hooks"];
/** Hooks that never run on the `NotFound` error path serving hot-added routes. */
const HANDLER_PHASE_HOOKS = ["transform", "beforeHandle", "afterHandle"] as const;

function handlerPhaseHookCount(hooks: RouteHooks | undefined): number {
  return HANDLER_PHASE_HOOKS.reduce((count, name) => {
    const hook: unknown = hooks?.[name];
    return count + (Array.isArray(hook) ? hook.length : Number(hook !== undefined));
  }, 0);
}

/** Whether the owner adds handler-phase hooks to the routes this app declares. */
function ownerAddsRouteHooks(app: AnyElysia, owner: AnyElysia): boolean {
  const anchor = app.routes.find((route) => typeof route.handler === "function");
  const mounted =
    anchor &&
    owner.routes.find(
      (route) =>
        route.method === anchor.method &&
        route.handler === anchor.handler &&
        route.path.endsWith(anchor.path)
    );
  return (
    mounted !== undefined &&
    handlerPhaseHookCount(mounted.hooks) !== handlerPhaseHookCount(anchor?.hooks)
  );
}

async function loadDevelopmentRoutes(resolvedPagesDir: string) {
  const { scanPages } = await import("../router/discovery.ts");
  return scanPages(resolvedPagesDir);
}

function createDevelopmentRouteSnapshot(
  instance: FurinInstance,
  root: RootLayout,
  routes: ResolvedRoute[]
): DevelopmentRouteSnapshot {
  const searchRoutes = createSearchRouteMetadata(routes);
  // The development shell binds each page handler to its route pattern.
  const routesByPattern = new Map(routes.map((route) => [route.pattern, route]));
  return {
    render: createRouteRenderer(
      instance,
      routes,
      root,
      "",
      searchRoutes,
      (key) => (typeof key === "string" ? routesByPattern.get(key) : undefined),
      developmentPagePorts
    ),
    root,
    routes,
  };
}

/** Serves a runtime from its page sources with Bun native HMR. */
export async function createDevRuntime(
  instance: FurinInstance,
  resolvedPagesDir: string,
  options: ModeOptions
): Promise<ModeRuntime> {
  const { prefix, syncPath } = instance;
  const { clientLogging, sync } = options;
  const cwd = process.cwd();
  // Each instance gets its own generated-files dir so two mounted apps do
  // not overwrite each other's hydrate entry (root keeps plain `.furin`).
  const instanceSlug = prefix === "" ? "" : prefixSlug(prefix);
  const furinDir = resolve(cwd, ".furin", instanceSlug);
  const { warnIfStripPluginMissing } = await import("../../plugin/preflight.ts");
  warnIfStripPluginMissing(cwd);
  // Lazy import — build pipeline has native deps not available in compiled binaries
  const { devDiagnosticStore, publishDevDiagnostic } = await import("./diagnostics.ts");
  const { devGraph, releaseDevGraph } = await import("./graph.ts");
  const { createDevDiagnosticPlugin } = await import("./plugin.ts");
  const { createDevelopmentBrowserEventSources } = await import("./browser-events.ts");
  const { registerDevPagePlugin } = await import("../dev-page-plugin.ts");
  registerDevPagePlugin();
  const { registerDevRoutesPlugin, registerDevRouteTopologyWatcher } = await import(
    "../../plugin/dev-routes.ts"
  );
  const { routeModuleSpecifier } = await import("../../plugin/route-tree.ts");
  const routeInstance = { pagesDir: resolvedPagesDir, prefix };
  registerDevRoutesPlugin([routeInstance]);

  // Furin never rewrites route sources: it only fills empty route files and
  // reports config mistakes in the terminal and the error overlay.
  const { createRouteConfigReporter, scaffoldEmptyRoutes } = await import(
    "../../plugin/route-config.ts"
  );
  const reportRouteConfig = createRouteConfigReporter(routeInstance, devDiagnosticStore(instance));
  scaffoldEmptyRoutes(resolvedPagesDir);

  const graph = devGraph(instance);
  const { nativeRoutesApp, root, routes } = await withInstance(instance, async () => {
    const { furinShell } = (await import(routeModuleSpecifier(routeInstance))) as {
      furinShell: AnyElysia;
    };
    const loaded = await loadDevelopmentRoutes(resolvedPagesDir);
    return { nativeRoutesApp: furinShell, ...loaded };
  });
  const initialSnapshot = createDevelopmentRouteSnapshot(instance, root, routes);
  const currentSnapshot = (): DevelopmentRouteSnapshot => graph.snapshot ?? initialSnapshot;
  let matchNavigationData = buildRouteMatcher(initialSnapshot.routes);
  let routeTopologyWatcher: ReturnType<typeof registerDevRouteTopologyWatcher> | undefined;
  let watcherOwner: AnyElysia | undefined;
  // Hot-added pages are served through the root `NotFound` handler until a
  // restart mounts them, so hooks a parent app added to pages skip them.
  const startupPatterns = new Set(initialSnapshot.routes.map((route) => route.pattern));
  const warnedHotAddedPatterns = new Set<string>();
  let parentHooksSkipHotAddedRoutes = false;
  const warnHotAddedRoutes = (current: readonly ResolvedRoute[]): void => {
    if (!parentHooksSkipHotAddedRoutes) {
      return;
    }
    for (const { pattern } of current) {
      if (startupPatterns.has(pattern) || warnedHotAddedPatterns.has(pattern)) {
        continue;
      }
      warnedHotAddedPatterns.add(pattern);
      console.warn(
        `[furin] ${pattern} was added while the dev server was running. Until a restart it is served through the not-found fallback, where hooks registered by a parent Elysia app (beforeHandle, derive, resolve...) do not run.`
      );
    }
  };
  bindRuntimeRoutes(instance, {
    matches: (path) => matchNavigationData(path) !== null,
    refresh: async () => {
      await routeTopologyWatcher?.refresh();
    },
    renderer: () => currentSnapshot().render,
  });

  const { writeDevFiles } = await import("../../build/hydrate.ts");
  const { discoverClientBoundaries, registerServerBoundaries } = await import(
    "../../rsc/build/discover.ts"
  );
  const { routeModuleSourceVersion } = await import("../router/source-version.ts");
  const { LINK_MODULE_PATH } = await import("../../build/shared.ts");
  const { getHmrDataSignature } = await import("../../plugin/transform-client.ts");
  let serverSourceVersion = 0;
  let serverDataSignatures = new Map<string, string>();
  let serverSourcePaths: string | undefined;
  const writeCurrentDevFiles = async (
    snapshot: DevelopmentRouteSnapshot,
    changedSources: readonly string[]
  ): Promise<void> => {
    const paths = [
      ...new Set([
        snapshot.root.path,
        ...snapshot.routes.flatMap((route) => [
          route.path,
          ...route.routeChain.flatMap((entry) => (entry.sourcePath ? [entry.sourcePath] : [])),
        ]),
      ]),
    ].toSorted();
    const clientBoundaries = await discoverClientBoundaries(paths, undefined);
    await registerServerBoundaries([
      ...clientBoundaries,
      ...clientBoundaries
        .filter(
          ({ path }) =>
            path !== LINK_MODULE_PATH.replaceAll("\\", "/") && !path.includes("/node_modules/")
        )
        .map((boundary) => ({
          ...boundary,
          path: `${boundary.path}?furin-server&t=${routeModuleSourceVersion(boundary.path)}`,
        })),
    ]);
    const nextPaths = JSON.stringify(paths);
    const nextSignatures = new Map(
      paths.map((path) => {
        let signature: string;
        try {
          signature = getHmrDataSignature(readFileSync(path, "utf8"), path);
          if (signature.startsWith("external:")) {
            signature = graph.sourceVersion(path);
          }
        } catch {
          // A broken route still needs a client entry for its diagnostic.
          signature = graph.sourceVersion(path);
        }
        return [path, signature] as const;
      })
    );
    // Route additions/removals already update the native client manifest.
    // Rebase their signature without issuing a second data invalidation.
    const changedPaths = new Set(changedSources);
    const importsChanged = paths.some(
      (path) =>
        !changedPaths.has(path) && serverDataSignatures.get(path) !== nextSignatures.get(path)
    );
    if (importsChanged && serverSourcePaths === nextPaths) {
      serverSourceVersion += 1;
    }
    serverSourcePaths = nextPaths;
    serverDataSignatures = nextSignatures;
    writeDevFiles(
      snapshot.routes,
      {
        basePath: prefix,
        clientLogging: clientLogging ?? false,
        clientBoundaries,
        outDir: furinDir,
        publicPath: `${prefix}/_client/`,
        rootLayout: snapshot.root.path,
        // furin-env.d.ts is one file at the project root — only the root
        // instance owns it, otherwise mounted apps clobber each other's types.
        skipRouteTypes: prefix !== "",
      },
      cwd,
      String(serverSourceVersion)
    );
  };
  await writeCurrentDevFiles(initialSnapshot, []);
  graph.commit(initialSnapshot);
  reportRouteConfig();
  const hmrEntry = (await import(join(furinDir, "index.html"))).default;
  const refreshDevelopmentRoutes = (changedSources: readonly string[]): Promise<void> =>
    withInstance(instance, async () => {
      invalidateStampedRouteModules();
      try {
        const previousSnapshot = currentSnapshot();
        const repaired = repairedDevelopmentRoutes(previousSnapshot, changedSources, graph);
        const next = await loadDevelopmentRoutes(resolvedPagesDir);
        // Retain tags only for routes whose current module could not be loaded.
        const nextRoutes = next.routes.map((route) =>
          route.routeChain.length > 0
            ? route
            : {
                ...route,
                tags: previousSnapshot.routes.find((previous) => previous.path === route.path)
                  ?.tags,
              }
        );
        const nextSnapshot = createDevelopmentRouteSnapshot(instance, next.root, nextRoutes);
        await writeCurrentDevFiles(nextSnapshot, changedSources);
        graph.commit(nextSnapshot);
        // A request served before this commit validated params and query with
        // the previous schemas; its loader output must not outlive them.
        for (const sourcePath of changedSources) {
          invalidateDevLoaderCacheBySource(sourcePath);
        }
        matchNavigationData = buildRouteMatcher(nextSnapshot.routes);
        warnHotAddedRoutes(nextSnapshot.routes);
        const diagnostics = devDiagnosticStore(instance);
        if (repaired.root) {
          diagnostics.markReady("*");
        }
        for (const pattern of repaired.patterns) {
          if (diagnostics.markReady(pattern)) {
            break;
          }
        }
      } catch (error) {
        publishDevDiagnostic(error, {
          entryPath: join(resolvedPagesDir, "root.tsx"),
          phase: "import",
          route: "*",
        });
        throw error;
      }
    });
  const publicDir = resolve(cwd, "public");
  const publicExists = existsSync(publicDir);
  const publicAssets = publicExists
    ? await staticPlugin({ assets: publicDir, prefix: "/public" })
    : new Elysia();
  const browserEvents = (await import("../browser-events/plugin.ts")).createBrowserEventsPlugin({
    development: instance.development,
    sources: createDevelopmentBrowserEventSources(instance, devDiagnosticStore(instance)),
    sync: sync || undefined,
  });

  return {
    nativeRoutes: nativeRoutesApp,
    // Routes registered below are LOGICAL — Elysia's `prefix` makes them
    // physical when this plugin is merged into the parent app (child prefixes
    // like staticPlugin's compose underneath).
    plugins: (app) =>
      app
        .onStart((owner) => {
          watcherOwner = owner;
          parentHooksSkipHotAddedRoutes = prefix === "" && ownerAddsRouteHooks(app, owner);
          routeTopologyWatcher = registerDevRouteTopologyWatcher({
            instance: routeInstance,
            owner: { app: owner.server ?? owner, prefix },
            onRouteFilesTouched: async (sourcePaths) => {
              scaffoldEmptyRoutes(resolvedPagesDir);
              await refreshDevelopmentRoutes(sourcePaths);
              reportRouteConfig();
            },
            onSourceError: (error, sourcePath) => {
              const route = currentSnapshot().routes.find((candidate) =>
                graph.dependsOn(candidate.path, sourcePath)
              );
              withInstance(instance, () =>
                publishDevDiagnostic(error, {
                  entryPath: route ? route.path : sourcePath,
                  phase: "transform",
                  route: route ? route.pattern : "*",
                })
              );
            },
            onTopologyChange: async (sourcePaths) => {
              // Bun --hot cannot be triggered from generated artifacts (its
              // watch graph is the entry's static imports), so topology changes
              // are served by swapping the dispatcher's route table. Hot-added
              // and removed routes then resolve through the runtime's
              // not-found path, which matches the current table.
              scaffoldEmptyRoutes(resolvedPagesDir);
              await refreshDevelopmentRoutes(sourcePaths);
              reportRouteConfig();
            },
          });
        })
        .onStop((owner) => {
          // A second application failing to start must not tear down the first one.
          if (owner !== watcherOwner) {
            return;
          }
          releaseDevGraph(instance);
          routeTopologyWatcher?.close();
          routeTopologyWatcher = undefined;
          watcherOwner = undefined;
        })
        .get("/_bun_hmr_entry/index.html", hmrEntry)
        .get("/_bun_hmr_entry", hmrEntry)
        .use(options.requestHooks)
        .use(publicAssets)
        .get(
          "/favicon.ico",
          publicExists
            ? file(join(publicDir, "favicon.ico"))
            : () => new Response(null, { status: 404 })
        )
        .use(browserEvents)
        .use(
          createDevDiagnosticPlugin(devDiagnosticStore(instance), instance, async () => {
            await routeTopologyWatcher?.refresh();
          })
        )
        .use(createInstrumentationPlugin(() => currentSnapshot().routes, syncPath)),
  };
}
