import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SsgCacheEntry } from "../server/cache/index.ts";

// import.meta.resolve() runs at runtime (not inlined at bundle time), resolves
// through package exports, and is the Web-standard API. The main entry is
// `src/furin.ts` (or `dist/furin.js`), so we strip two path segments to reach
// the package root.
const _pkgRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@teyik0/furin"))));
const _pkgSrcDirRaw = existsSync(join(_pkgRoot, "src", "furin.ts"))
  ? join(_pkgRoot, "src")
  : join(_pkgRoot, "dist");
// Normalize to forward slashes so endsWith checks and template paths work on Windows.
const _pkgSrcDir = _pkgSrcDirRaw.replace(/\\/g, "/");
const _ext = _pkgSrcDir.endsWith("/src") ? ".ts" : ".js";
const INTERNAL_MODULE_PATH = `${_pkgSrcDir}/server/internal${_ext}`;
const RUNTIME_ENV_MODULE_PATH = `${_pkgSrcDir}/server/runtime-env${_ext}`;

/** One app's compile context payload — the generated entry can carry several. */
export interface EntryAppContext {
  buildId?: string;
  /** Whether the emitted hydration client sends browser log batches. */
  clientLogging?: boolean;
  /** Extra lines injected inside this app's `__setCompileContext({...})` call. */
  extraContext?: string[];
  /** Extra import lines this app needs (embedded asset imports). */
  extraImports?: string[];
  /** Additional route modules such as filesystem-derived `_route` layouts. */
  modulePaths?: string[];
  /** Virtual module specifier exporting this app's composed Elysia route tree. */
  nativeRoutes?: string;
  /** Mount prefix baked into the context for runtime lookup (`""` = root). */
  prefix?: string;
  rootConventions?: { errorPath?: string; notFoundPath?: string };
  rootPath: string;
  routeMetadata?: Record<
    string,
    {
      segmentBoundaries: Array<{
        depth: number;
        path: string;
        errorPath?: string;
        notFoundPath?: string;
      }>;
    }
  >;
  routes: Array<{ mode: "ssr" | "ssg" | "isr"; path: string; pattern: string }>;
  ssgCache?: Record<string, SsgCacheEntry>;
}

export interface EntryTemplateOptions {
  apps: EntryAppContext[];
  headerComment: string;
  /**
   * - "boot" (default): forces production mode and dynamically imports the
   *   server entry after registering contexts — the whole app's entrypoint.
   * - "register": ONLY registers contexts. Emitted by `--target package` as a
   *   side-effect module the HOST app imports; it must not touch dev mode or
   *   NODE_ENV (the host decides), and it imports furin internals via the
   *   package specifier so the host and the register module share ONE copy of
   *   the context registry (`packages: "external"` keeps it unbundled).
   */
  mode?: "boot" | "register";
  /**
   * Server entry to boot after context registration. Omitted in package
   * (register-module) mode where the entry only registers contexts.
   */
  serverEntry?: string;
}

/** Unified options for generating a build entry (compile or disk-based). */
export interface BuildEntryOptions {
  apps: Array<
    EntryAppContext & {
      /** Embed mode: bundles this app's client assets via `with { type: "file" }`. */
      embed?: { clientDir: string };
    }
  >;
  headerComment?: string;
  outDir: string;
  /** Project-level public/ dir — embedded into EVERY app's assets (keys only; Bun dedupes the file payloads). */
  publicDir?: string;
  serverEntry?: string;
}

function collectConventionPaths(
  rootConventions: EntryAppContext["rootConventions"],
  routeMetadata: EntryAppContext["routeMetadata"]
): string[] {
  const paths: string[] = [];
  if (rootConventions?.errorPath) {
    paths.push(rootConventions.errorPath);
  }
  if (rootConventions?.notFoundPath) {
    paths.push(rootConventions.notFoundPath);
  }
  if (routeMetadata) {
    for (const meta of Object.values(routeMetadata)) {
      for (const seg of meta.segmentBoundaries) {
        if (seg.errorPath) {
          paths.push(seg.errorPath);
        }
        if (seg.notFoundPath) {
          paths.push(seg.notFoundPath);
        }
      }
    }
  }
  return [...new Set(paths)];
}

/** Emits one app's module imports + `__setCompileContext({...})` call. */
function buildAppContextBlock(
  app: EntryAppContext,
  varPrefix: string
): { contextLines: string[]; importLines: string[] } {
  const allModulePaths = [
    ...new Set([
      app.rootPath,
      ...app.routes.map((r) => r.path),
      ...(app.modulePaths ?? []),
      ...collectConventionPaths(app.rootConventions, app.routeMetadata),
    ]),
  ];
  const importLines: string[] = [];
  const moduleEntries: string[] = [];

  for (let i = 0; i < allModulePaths.length; i++) {
    const absPath = (allModulePaths[i] as string).replace(/\\/g, "/");
    const varName = `${varPrefix}mod${i}`;
    importLines.push(`import * as ${varName} from ${JSON.stringify(absPath)};`);
    moduleEntries.push(`  ${JSON.stringify(absPath)}: ${varName},`);
  }
  const nativeRoutesVar = `${varPrefix}furinApp`;
  if (app.nativeRoutes) {
    importLines.push(
      `import { furinApp as ${nativeRoutesVar} } from ${JSON.stringify(app.nativeRoutes)};`
    );
  }

  const routeEntries = app.routes.map(
    (r) =>
      `    { pattern: ${JSON.stringify(r.pattern)}, path: ${JSON.stringify(r.path.replace(/\\/g, "/"))}, mode: ${JSON.stringify(r.mode)} },`
  );

  const rootConventionsLine = app.rootConventions
    ? `  rootConventions: ${JSON.stringify(app.rootConventions)},`
    : "";
  const routeMetadataLine = app.routeMetadata
    ? `  routeMetadata: ${JSON.stringify(app.routeMetadata)},`
    : "";
  const ssgCacheLine = app.ssgCache ? `  ssgCache: ${JSON.stringify(app.ssgCache)},` : "";

  const contextLines = [
    "__setCompileContext({",
    `  buildId: ${JSON.stringify(app.buildId ?? "")},`,
    `  clientLogging: ${JSON.stringify(app.clientLogging ?? false)},`,
    `  prefix: ${JSON.stringify(app.prefix ?? "")},`,
    `  rootPath: ${JSON.stringify(app.rootPath.replace(/\\/g, "/"))},`,
    app.nativeRoutes ? `  nativeRoutes: ${nativeRoutesVar},` : "",
    rootConventionsLine,
    "  modules: {",
    ...moduleEntries,
    "  },",
    "  routes: [",
    ...routeEntries,
    "  ],",
    routeMetadataLine,
    ssgCacheLine,
    ...(app.extraContext ?? []),
    "});",
  ];

  return { contextLines, importLines };
}

export function buildEntrySource(options: EntryTemplateOptions): string {
  const { apps, headerComment, serverEntry } = options;
  const mode = options.mode ?? "boot";
  const internalSpecifier =
    mode === "register" ? "@teyik0/furin/internal" : INTERNAL_MODULE_PATH;

  const importLines: string[] = [];
  const contextBlocks: string[] = [];

  for (let appIndex = 0; appIndex < apps.length; appIndex++) {
    const app = apps[appIndex] as EntryAppContext;
    // Per-app variable namespace so several apps' module/asset imports never
    // collide inside the single generated entry.
    const varPrefix = apps.length === 1 ? "_" : `_a${appIndex}_`;
    const block = buildAppContextBlock(app, varPrefix);
    importLines.push(...block.importLines);
    if (app.extraImports && app.extraImports.length > 0) {
      importLines.push("", ...app.extraImports);
    }
    contextBlocks.push("", ...block.contextLines);
  }

  const lines = [
    headerComment,
    `import { __setCompileContext } from ${JSON.stringify(internalSpecifier)};`,
    ...(mode === "boot"
      ? [`import { __setDevMode } from ${JSON.stringify(RUNTIME_ENV_MODULE_PATH)};`]
      : []),
    ...importLines,
    ...(mode === "boot"
      ? [
          "",
          "// Force production mode — Bun may inline process.env.NODE_ENV at bundle time.",
          "__setDevMode(false);",
          'process.env.NODE_ENV = "production";',
        ]
      : []),
    ...contextBlocks,
    "",
    ...(serverEntry
      ? [`await import(${JSON.stringify(serverEntry.replace(/\\/g, "/"))});`, ""]
      : []),
  ];

  return lines.join("\n");
}
