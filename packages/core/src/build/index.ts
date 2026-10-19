// biome-ignore-all lint/performance/noAwaitInLoops: build phases run in sequence because later phases consume prior artifacts
import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildAdapterTarget } from "../adapter/build.ts";
import { bun } from "../adapter/bun.ts";
import { buildPackageTarget } from "../adapter/package";
import type { RuntimeTargetApp } from "../adapter/runtime-build";
import { buildStaticTarget } from "../adapter/static";
import type { FurinAdapter } from "../adapter/types.ts";
import { vercel } from "../adapter/vercel.ts";
import { BUILD_TARGETS, type BuildTarget, type FurinPlugin, type FurinTarget } from "../config";
import { assertValidRouteConfig } from "../plugin/route-config.ts";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { normalizePrefix } from "../server/instance.ts";
import { scanPages } from "../server/router/discovery.ts";
import { assertNoPrefixSlugCollisions } from "../shared/prefix.ts";
import { withProductionBuild } from "../shared/production-build.ts";
import { discoverFurinMounts } from "./discover-mounts.ts";
import { writeRouteTypes } from "./route-types";
import { ensureDir, toBuildRouteManifestEntry, toPosixPath } from "./shared";
import type { BuildAppOptions, BuildAppResult, BuildManifest } from "./types";

// biome-ignore lint/performance/noBarrelFile: intentional — build/index.ts is the public build API entry
export { buildClient } from "./client";
export { writeRouteTypes } from "./route-types";
export type {
  BuildAppOptions,
  BuildAppResult,
  BuildClientOptions,
  BuildManifest,
  BuildRouteManifestEntry,
  TargetBuildManifest,
  VercelTargetBuildManifest,
} from "./types";

// "package" is intentionally excluded from `--target all` — it is an
// alternative packaging of ONE app, not an additional deploy target.
const IMPLEMENTED_TARGETS = ["bun", "vercel", "static"] as const satisfies BuildTarget[];

/** Targets without a server bundle: static ships none, package leaves it to the host. */
function isServerless(target: FurinTarget): target is "package" | "static" {
  return target === "static" || target === "package";
}

function requestedTargets(target: BuildAppOptions["target"]): FurinTarget[] {
  if (target === "all") {
    return [...IMPLEMENTED_TARGETS];
  }
  const targets = Array.isArray(target) ? target : [target];
  for (const entry of targets) {
    if (typeof entry === "string" && !(BUILD_TARGETS as readonly string[]).includes(entry)) {
      throw new Error(`[furin] Unsupported build target "${entry}"`);
    }
  }
  return targets;
}

function adapterFor(target: FurinAdapter | "bun" | "vercel", options: BuildAppOptions): FurinAdapter {
  if (typeof target !== "string") {
    return target;
  }
  return target === "bun" ? bun(options.compile) : vercel({});
}
const BUILD_OUTPUT_DIR = ".furin/build";
let isomorphicRuntimePluginRegistered = false;

function registerIsomorphicRuntimePlugin(): void {
  if (isomorphicRuntimePluginRegistered) {
    return;
  }
  Bun.plugin(isomorphicTransformPlugin("server"));
  isomorphicRuntimePluginRegistered = true;
}

/**
 * Resolves the list of apps to build, in priority order:
 * 1. explicit `apps` config (furin.config.ts),
 * 2. explicit single `pagesDir` option (mounted at root),
 * 3. every `furin({ pagesDir, prefix })` call made by evaluating the server entry,
 * 4. the `src/pages` default.
 */
async function resolveAppSpecs(
  options: RouteTypegenOptions,
  serverEntry: string | null,
  rootDir: string
): Promise<Array<{ pagesDir: string; prefix: string }>> {
  if (options.apps && options.apps.length > 0) {
    // normalizePrefix is the choke point for config/CLI-provided prefixes:
    // `"/"` → `""` (otherwise the bun target derives `publicPath: "//_client/"`,
    // a protocol-relative URL), trailing slashes are trimmed, and invalid
    // prefixes throw before any build output is written.
    return options.apps.map((app) => ({
      pagesDir: resolve(rootDir, app.pagesDir),
      prefix: normalizePrefix(app.prefix),
    }));
  }
  if (options.pagesDir) {
    return [{ pagesDir: resolve(rootDir, options.pagesDir), prefix: "" }];
  }
  if (serverEntry) {
    const mounted = await discoverFurinMounts(serverEntry, rootDir);
    if (mounted.length > 0) {
      return mounted.map((app) => ({
        pagesDir: resolve(rootDir, app.pagesDir),
        prefix: app.prefix,
      }));
    }
  }
  return [{ pagesDir: resolve(rootDir, "src/pages"), prefix: "" }];
}

/**
 * Registers runtime plugins, resolves the configured apps and scans their
 * pages. Shared by `buildApp()` and `generateRouteTypes()`.
 */
async function scanApps(
  options: RouteTypegenOptions,
  serverEntry: string | null,
  rootDir: string
): Promise<RuntimeTargetApp[]> {
  // Register user plugins as runtime module loaders BEFORE scanPages.
  //
  // scanPages() calls import() on every page file, which triggers all their
  // static imports (e.g. ".mdx" files). If the loader is not yet registered
  // at that point, Bun caches the raw/unprocessed result — and that cached
  // value is reused for every subsequent import(), including prerenderSSG().
  //
  // Plugins marked `buildOnly` (e.g. bun-plugin-tailwind uses onBeforeParse,
  // which doesn't exist in the runtime context) only affect Bun.build()
  // bundles. Any other registration failure would make route imports differ
  // from the bundle, so it fails the build.
  for (const plugin of options.plugins ?? []) {
    const { buildOnly, ...runtimePlugin } = plugin as FurinPlugin;
    if (buildOnly) {
      continue;
    }
    try {
      Bun.plugin(runtimePlugin);
    } catch (err) {
      throw new Error(
        `[furin] Plugin "${runtimePlugin.name}" could not be registered for server-side route imports: ${err instanceof Error ? err.message : String(err)}\n` +
          "If it only transforms the client bundle (for example bun-plugin-tailwind), mark it build-only in furin.config.ts:\n" +
          "  plugins: [{ ...plugin, buildOnly: true }]",
        { cause: err }
      );
    }
  }
  registerIsomorphicRuntimePlugin();

  const appSpecs = await resolveAppSpecs(options, serverEntry, rootDir);
  const duplicatePrefix = appSpecs.find(
    (spec, index) => appSpecs.findIndex((other) => other.prefix === spec.prefix) !== index
  );
  if (duplicatePrefix) {
    throw new Error(
      `[furin] Two apps are configured with the prefix "${duplicatePrefix.prefix || "/"}" — give each app a unique prefix.`
    );
  }
  // Distinct prefixes can still slug to the same client dir (`/a-b` vs `/a/b`
  // → `client-a-b`), which would let a later app's assets overwrite an earlier
  // one's — reject before any target writes output.
  assertNoPrefixSlugCollisions(appSpecs.map((spec) => spec.prefix));

  // scanPages throws if root.tsx is missing, so root is always defined per app.
  const apps: RuntimeTargetApp[] = [];
  for (const spec of appSpecs) {
    assertValidRouteConfig(spec);
    const { root, routes } = await scanPages(spec.pagesDir);
    apps.push({ pagesDir: spec.pagesDir, prefix: spec.prefix, root, routes });
  }
  return apps;
}

function writeRootRouteTypes(apps: RuntimeTargetApp[], rootDir: string): void {
  const rootApp = apps.find((app) => app.prefix === "");
  if (rootApp) {
    writeRouteTypes(rootApp.routes, rootDir, rootApp.pagesDir);
  }
}

/** Options for `generateRouteTypes()`, a subset of the build options. */
export type RouteTypegenOptions = Pick<
  BuildAppOptions,
  "apps" | "pagesDir" | "plugins" | "rootDir" | "serverEntry"
>;

/**
 * Writes `furin-env.d.ts` for the root-mounted app without building, e.g.
 * before `tsc` in CI. Prefixed apps are skipped, as in development.
 */
export function generateRouteTypes(options: RouteTypegenOptions): Promise<void> {
  return withProductionBuild(async () => {
    const rootDir = resolve(options.rootDir ?? process.cwd());
    const entry = resolve(rootDir, options.serverEntry ?? "src/server.ts");
    const apps = await scanApps(options, existsSync(entry) ? entry : null, rootDir);
    writeRootRouteTypes(apps, rootDir);
  });
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  return withProductionBuild(() => buildAppInternal(options));
}

async function buildAppInternal(options: BuildAppOptions): Promise<BuildAppResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const buildRoot = join(rootDir, BUILD_OUTPUT_DIR);
  const targets = requestedTargets(options.target);
  const serverEntry = (() => {
    if (targets.every(isServerless)) {
      return null;
    }
    if (options.serverEntry) {
      const resolved = resolve(rootDir, options.serverEntry);
      if (existsSync(resolved)) {
        return resolved;
      }
    }
    const entry = resolve(rootDir, "src/server.ts");
    if (!existsSync(entry)) {
      throw new Error(
        "[furin] Server targets need a server entry: src/server.ts not found. Create it or set `serverEntry` in furin.config.ts."
      );
    }
    return entry;
  })();

  const apps = await scanApps(options, serverEntry, rootDir);
  // furin-env.d.ts is one file at the project root, owned by the root-mounted
  // app — the same rule as the dev server, so builds keep types current too.
  writeRootRouteTypes(apps, rootDir);
  // The root-mounted app drives single-app manifest fields and the static target.
  const primaryApp = (apps.find((app) => app.prefix === "") ?? apps[0]) as RuntimeTargetApp;

  ensureDir(buildRoot);

  const manifest: BuildManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    rootDir: toPosixPath(rootDir),
    pagesDir: toPosixPath(relative(rootDir, primaryApp.pagesDir)),
    rootPath: toPosixPath(relative(rootDir, primaryApp.root.path)),
    serverEntry: serverEntry ? toPosixPath(relative(rootDir, serverEntry)) : null,
    routes: primaryApp.routes.map((route) => toBuildRouteManifestEntry(route, rootDir)),
    apps: apps.map((app) => ({
      pagesDir: toPosixPath(relative(rootDir, app.pagesDir)),
      prefix: app.prefix,
      routes: app.routes.map((route) => toBuildRouteManifestEntry(route, rootDir)),
    })),
    targets: {},
  };

  for (const target of targets) {
    if (target === "static") {
      if (apps.length > 1) {
        console.warn(
          "[furin] `--target static` exports the root-mounted app only — prefixed apps are skipped."
        );
      }
      // The static adapter only knows about staticConfig.basePath — the mount
      // prefix is a server-side concept it never sees. Exporting a prefixed
      // app without a matching basePath produces root-relative asset URLs.
      if (primaryApp.prefix !== "") {
        console.warn(
          `[furin] \`--target static\` exports an app mounted at "${primaryApp.prefix}", but the ` +
            `static export ignores the mount prefix — set \`static.basePath\` to "${primaryApp.prefix}" ` +
            "(or the sub-path the site is served from) so asset URLs resolve correctly."
        );
      }
      manifest.targets.static = await buildStaticTarget(
        primaryApp.routes,
        rootDir,
        buildRoot,
        primaryApp.root,
        options
      );
      continue;
    }
    if (target === "package") {
      if (apps.length > 1) {
        throw new Error(
          "[furin] `--target package` builds exactly one app — configure a single pagesDir/prefix."
        );
      }
      manifest.targets.package = await buildPackageTarget(primaryApp, rootDir, buildRoot, options);
      continue;
    }
    const adapter = adapterFor(target, options);
    manifest.targets[adapter.name] = await buildAdapterTarget(
      adapter,
      apps,
      rootDir,
      buildRoot,
      serverEntry as string,
      options
    );
  }

  writeFileSync(join(buildRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    targets: manifest.targets,
  };
}
