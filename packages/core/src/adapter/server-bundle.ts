import { dirname, relative } from "node:path";
import { elysiaAot } from "../build/elysia-aot.ts";
import { productionInstrumentationPlugin } from "../build/production-instrumentation.ts";
import { createRoutesPlugin } from "../plugin/routes.ts";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { clientReferencesPlugin } from "../rsc/build/client-references.ts";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { mixedRuntimePlugin, pprRuntimePlugin, type RuntimeTargetApp } from "./runtime-build.ts";

const APP_SPECIFIER_RE = /^furin:app$/;
const PRERENDER_SNAPSHOT_RE = /^\.\/furin-prerender\.json$/;
const ELYSIA_STATIC_IMPORT_RE = /^@elysia\/static$/;
const MATCH_ALL_RE = /.*/;
const STATIC_STUB_NAMESPACE = "furin-platform-assets-stub";
const FURIN_RUNTIME_ROOT = dirname(import.meta.dir);

function isFurinRuntimeImporter(importer: string): boolean {
  if (importer === "") {
    return false;
  }
  const fromRuntimeRoot = relative(FURIN_RUNTIME_ROOT, importer.split("?")[0] as string);
  return (
    fromRuntimeRoot !== ".." &&
    !fromRuntimeRoot.startsWith("../") &&
    !fromRuntimeRoot.startsWith("..\\")
  );
}

/** Resolves `furin:app`, the specifier runtime modules import the application from. */
function appSpecifierPlugin(appEntry: string): Bun.BunPlugin {
  return {
    name: "furin-app-specifier",
    setup(build) {
      build.onResolve({ filter: APP_SPECIFIER_RE }, () => ({ path: appEntry }));
    },
  };
}

/**
 * Keeps the prerender snapshot a sidecar file: the build writes it after
 * rendering with this very bundle, and runtime reads it next to the bundle.
 */
function prerenderSnapshotPlugin(): Bun.BunPlugin {
  return {
    name: "furin-prerender-snapshot",
    setup(build) {
      build.onResolve({ filter: PRERENDER_SNAPSHOT_RE }, ({ path }) => ({ external: true, path }));
    },
  };
}

/** Application static mounts would read files the platform never deploys. */
function platformAssetsPlugin(adapterName: string): Bun.BunPlugin {
  return {
    name: "furin-platform-assets",
    setup(build) {
      build.onResolve({ filter: ELYSIA_STATIC_IMPORT_RE }, ({ importer }) => {
        if (!isFurinRuntimeImporter(importer)) {
          throw new Error(
            `[furin] Application @elysia/static mounts are not supported by the "${adapterName}" adapter: its platform serves assets. Put them under public/ instead.`
          );
        }
        return { namespace: STATIC_STUB_NAMESPACE, path: "@elysia/static" };
      });
      build.onLoad({ filter: MATCH_ALL_RE, namespace: STATIC_STUB_NAMESPACE }, () => ({
        contents: `export function staticPlugin() {
  throw new Error("[furin] The deployment platform owns production assets.");
}`,
        loader: "js",
      }));
    },
  };
}

export interface ServerBundlePluginsOptions {
  /** Application entry evaluated by Elysia AOT; omitted when the host owns the app. */
  appEntry: string | undefined;
  apps: RuntimeTargetApp[];
  /** Name of the adapter whose platform serves assets, when it does. */
  platformAssets: string | undefined;
  /** Project root; relative furin() pagesDirs resolve against it. */
  rootDir: string;
  userPlugins: Bun.BunPlugin[] | undefined;
}

/**
 * The order-sensitive plugin chain of every server bundle. Framework resolvers
 * run before user plugins, route and RSC transforms after them, and Elysia AOT
 * last so it compiles the fully transformed application.
 */
export function serverBundlePlugins(options: ServerBundlePluginsOptions): Bun.BunPlugin[] {
  const { appEntry, apps, platformAssets, rootDir, userPlugins } = options;
  return [
    ...(appEntry === undefined ? [] : [appSpecifierPlugin(appEntry)]),
    prerenderSnapshotPlugin(),
    ...(platformAssets === undefined ? [] : [platformAssetsPlugin(platformAssets)]),
    productionInstrumentationPlugin(),
    pprRuntimePlugin(apps),
    mixedRuntimePlugin(apps),
    ...(userPlugins ?? []),
    createRoutesPlugin({ instances: apps, target: "server" }),
    clientReferencesPlugin(),
    isomorphicTransformPlugin("server"),
    environmentGuardPlugin("ssr"),
    ...(appEntry === undefined ? [] : [elysiaAot(appEntry, { apps, rootDir })]),
  ];
}
