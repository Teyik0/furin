// biome-ignore-all lint/performance/noAwaitInLoops: build phases run in sequence because later phases consume prior artifacts
import { existsSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { buildBunTarget, type BunTargetApp } from "../adapter/bun";
import { buildPackageTarget } from "../adapter/package";
import { buildStaticTarget } from "../adapter/static";
import { BUILD_TARGETS, type BuildTarget, type FurinPlugin } from "../config";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { normalizePrefix } from "../server/instance.ts";
import { scanPages } from "../server/router/discovery.ts";
import { assertNoPrefixSlugCollisions } from "../shared/prefix.ts";
import { scanFurinInstances } from "./scan-server";
import { ensureDir, toBuildRouteManifestEntry, toPosixPath } from "./shared";
import type { BuildAppOptions, BuildAppResult, BuildManifest } from "./types";

// biome-ignore lint/performance/noBarrelFile: intentional — build/index.ts is the public build API entry
export { buildClient } from "./client";
export { writeDevFiles } from "./hydrate";
export { writeRouteTypes } from "./route-types";
export { buildSSGCacheSnapshot, type SSGCacheSnapshot } from "./ssg-cache";
export type {
  BuildAppOptions,
  BuildAppResult,
  BuildClientOptions,
  BuildManifest,
  BuildRouteManifestEntry,
  TargetBuildManifest,
} from "./types";

// "package" is intentionally excluded from `--target all` — it is an
// alternative packaging of ONE app, not an additional deploy target.
const IMPLEMENTED_TARGETS = ["bun", "static"] as const satisfies BuildTarget[];
export const BUILD_OUTPUT_DIR = ".furin/build";
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
 * 3. every `furin({ pagesDir, prefix })` call detected in the server entry,
 * 4. the `src/pages` default.
 */
function resolveAppSpecs(
  options: BuildAppOptions,
  serverEntry: string | null,
  rootDir: string
): Array<{ pagesDir: string; prefix: string }> {
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
    const detected = scanFurinInstances(serverEntry);
    if (detected.length > 0) {
      return detected.map((app) => ({
        pagesDir: resolve(rootDir, app.pagesDir),
        prefix: app.prefix,
      }));
    }
  }
  return [{ pagesDir: resolve(rootDir, "src/pages"), prefix: "" }];
}

export async function buildApp(options: BuildAppOptions): Promise<BuildAppResult> {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const buildRoot = join(rootDir, BUILD_OUTPUT_DIR);
  const serverEntry = (() => {
    // Static and package builds don't need a server entry point
    if (options.target === "static" || options.target === "package") {
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
      throw new Error("[furin] Entrypoint server.ts not found");
    }
    return entry;
  })();

  // Register user plugins as runtime module loaders BEFORE scanPages.
  //
  // scanPages() calls import() on every page file, which triggers all their
  // static imports (e.g. ".mdx" files). If the loader is not yet registered
  // at that point, Bun caches the raw/unprocessed result — and that cached
  // value is reused for every subsequent import(), including prerenderSSG().
  //
  // Build-only plugins (e.g. bun-plugin-tailwind uses onBeforeParse which
  // doesn't exist in the runtime context) are skipped silently — they only
  // affect the Bun.build() client bundle, not server-side rendering.
  for (const plugin of options.plugins ?? []) {
    const { buildOnly, ...runtimePlugin } = plugin as FurinPlugin;
    if (buildOnly) {
      continue;
    }
    try {
      Bun.plugin(runtimePlugin);
    } catch (err) {
      console.debug("[furin] Skipped plugin at runtime:", err);
    }
  }
  registerIsomorphicRuntimePlugin();

  const appSpecs = resolveAppSpecs(options, serverEntry, rootDir);
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

  const requestedTargets =
    options.target === "all"
      ? [...IMPLEMENTED_TARGETS]
      : [options.target].map((target) => {
          if (!(BUILD_TARGETS as readonly string[]).includes(target)) {
            throw new Error(`[furin] Unsupported build target "${target}"`);
          }
          return target as BuildTarget;
        });

  // scanPages throws if root.tsx is missing, so root is always defined per app.
  const apps: BunTargetApp[] = [];
  for (const spec of appSpecs) {
    const { root, routes } = await scanPages(spec.pagesDir);
    apps.push({ pagesDir: spec.pagesDir, prefix: spec.prefix, root, routes });
  }
  // The root-mounted app drives single-app manifest fields and the static target.
  const primaryApp = (apps.find((app) => app.prefix === "") ?? apps[0]) as BunTargetApp;

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

  for (const target of requestedTargets) {
    switch (target) {
      case "bun":
        manifest.targets.bun = await buildBunTarget(apps, rootDir, buildRoot, serverEntry, options);
        break;
      case "static":
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
        break;
      case "package":
        if (apps.length > 1) {
          throw new Error(
            "[furin] `--target package` builds exactly one app — configure a single pagesDir/prefix."
          );
        }
        manifest.targets.package = await buildPackageTarget(
          primaryApp,
          rootDir,
          buildRoot,
          options
        );
        break;
      case "node":
      case "vercel":
      case "cloudflare":
        throw new Error(
          `[furin] \`--target ${target}\` is planned but not implemented yet in this branch.`
        );
      default:
        throw new Error(`[furin] Unsupported build target "${target}"`);
    }
  }

  writeFileSync(join(buildRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  return {
    manifest,
    targets: manifest.targets,
  };
}
