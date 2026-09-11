import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runBunBuild } from "../build/bun-build.ts";
import { buildEntrySource } from "../build/entry-template.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { SSGPrerender } from "../build/ssg-cache.ts";
import type { BuildAppOptions, VercelTargetBuildManifest } from "../build/types.ts";
import { createVirtualBuildEntry } from "../build/virtual-entry.ts";
import { createRoutesPlugin } from "../plugin/routes.ts";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { compareRouteSpecificity, resolveRouteRevalidate } from "../server/router/patterns.ts";
import {
  buildRuntimeAppsSequentially,
  type RuntimeAppBuild,
  type RuntimeTargetApp,
} from "./runtime-build.ts";

const ISR_PATH_PARAM = "__furin_path";
const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/;
const UNSAFE_FUNCTION_PATH_RE = /[^a-zA-Z0-9_.[\]/-]/g;
const VERCEL_FUNCTIONS_PATH = fileURLToPath(import.meta.resolve("@vercel/functions"));

interface VercelRoute {
  continue?: boolean;
  dest?: string;
  handle?: "filesystem";
  headers?: { "cache-control": string };
  src?: string;
}

interface VercelBuildOutputConfig {
  framework: { name: "furin"; version: string };
  routes: VercelRoute[];
  version: 3;
}

interface PrerenderConfig {
  expiration: number | false;
  fallback?: string;
  initialHeaders?: {
    "content-type": string;
    location?: string;
    "vercel-cache-tag": string;
  };
  initialStatus?: number;
  passQuery: true;
}

interface PrerenderSpec {
  config: PrerenderConfig;
  exact: boolean;
  functionName: string;
  pattern: string;
  source: string;
}

function frameworkVersion(): string {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@teyik0/furin"))));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return packageJson.version;
}

function serverEntryLoader(serverEntry: string): "js" | "jsx" | "ts" | "tsx" {
  const extension = extname(serverEntry);
  if (extension === ".tsx") {
    return "tsx";
  }
  if (extension === ".jsx") {
    return "jsx";
  }
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") {
    return "js";
  }
  return "ts";
}

function assertDefaultServerExport(serverEntry: string): void {
  const transpiler = new Bun.Transpiler({ loader: serverEntryLoader(serverEntry) });
  const { exports } = transpiler.scan(readFileSync(serverEntry, "utf8"));
  if (!exports.includes("default")) {
    throw new Error(
      `[furin] Vercel server entry "${toPosixPath(serverEntry)}" must export the Elysia app as default. ` +
        "Guard app.listen() with `if (import.meta.main)` so the same entry also runs locally."
    );
  }
}

function escapeRegex(value: string): string {
  let escaped = "";
  for (const character of value) {
    escaped += REGEX_META_RE.test(character) ? `\\${character}` : character;
  }
  return escaped;
}

function physicalPath(prefix: string, path: string): string {
  if (prefix === "") {
    return path;
  }
  return path === "/" ? prefix : `${prefix}${path}`;
}

function routePatternSource(prefix: string, pattern: string): string {
  const path = physicalPath(prefix, pattern);
  let source = "";
  let index = 0;
  while (index < path.length) {
    const character = path[index];
    if (character === ":") {
      index += 1;
      while (index < path.length && path[index] !== "/") {
        index += 1;
      }
      source += "[^/]+";
      continue;
    }
    if (character === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (character !== undefined) {
      source += REGEX_META_RE.test(character) ? `\\${character}` : character;
    }
    index += 1;
  }
  return `(?<${ISR_PATH_PARAM}>${source})`;
}

function exactPathSource(path: string): string {
  return `(?<${ISR_PATH_PARAM}>${escapeRegex(path)})`;
}

function functionNameForPath(path: string, mode: "isr" | "ssg"): string {
  const normalized =
    path
      .split("/")
      .filter(Boolean)
      .map((segment) => {
        if (segment === "*") {
          return "[...splat]";
        }
        if (segment.startsWith(":")) {
          return `[${segment.slice(1)}]`;
        }
        const sanitized = segment.replace(UNSAFE_FUNCTION_PATH_RE, "-");
        if (sanitized === segment && segment !== "." && segment !== "..") {
          return segment;
        }
        const readable = sanitized.replaceAll(".", "-") || "route";
        return `${readable}-${Bun.hash(segment).toString(16).slice(0, 8)}`;
      })
      .join("/") || "index";
  const slash = normalized.lastIndexOf("/");
  if (slash === -1) {
    return `${normalized}-${mode}`;
  }
  return `${normalized.slice(0, slash + 1)}${normalized.slice(slash + 1)}-${mode}`;
}

function destinationForFunction(functionName: string): string {
  return `/${functionName}?${ISR_PATH_PARAM}=$${ISR_PATH_PARAM}`;
}

function hasRequestLoader(app: RuntimeTargetApp, prerender: SSGPrerender): boolean {
  return (
    app.root.route.requestLoader !== undefined ||
    prerender.route.routeChain.some((route) => route.requestLoader !== undefined)
  );
}

async function addSsgFallback(
  spec: PrerenderSpec,
  physicalRoutePath: string,
  prerender: SSGPrerender,
  functionsDir: string
): Promise<void> {
  const fallback = `${basename(spec.functionName)}.prerender-fallback.html`;
  const { result } = prerender;
  let body: string;
  let contentType = "text/html; charset=utf-8";
  let location: string | undefined;
  let status: number;

  if (result instanceof Response) {
    body = await result.text();
    contentType = result.headers.get("content-type") ?? contentType;
    location = result.headers.get("location") ?? undefined;
    ({ status } = result);
  } else {
    body = result.html;
    ({ status } = result);
  }

  const fallbackPath = join(dirname(join(functionsDir, spec.functionName)), fallback);
  ensureDir(dirname(fallbackPath));
  writeFileSync(fallbackPath, body);
  spec.config.fallback = fallback;
  spec.config.initialHeaders = {
    "content-type": contentType,
    ...(location === undefined ? {} : { location }),
    "vercel-cache-tag": physicalRoutePath,
  };
  spec.config.initialStatus = status;
}

function createFunctionAlias(
  functionsDir: string,
  serverFunctionDir: string,
  functionName: string
): void {
  const aliasPath = join(functionsDir, `${functionName}.func`);
  ensureDir(dirname(aliasPath));
  const target = relative(dirname(aliasPath), serverFunctionDir);
  symlinkSync(target, aliasPath, process.platform === "win32" ? "junction" : "dir");
}

async function createPrerenderSpecs(
  apps: RuntimeTargetApp[],
  builds: RuntimeAppBuild[],
  functionsDir: string
): Promise<PrerenderSpec[]> {
  const specs = new Map<string, PrerenderSpec>();

  for (const app of apps) {
    for (const route of app.routes) {
      if (route.mode === "ssr") {
        continue;
      }
      const physicalPattern = physicalPath(app.prefix, route.pattern);
      const source = routePatternSource(app.prefix, route.pattern);
      specs.set(source, {
        config: {
          expiration: route.mode === "ssg" ? false : (resolveRouteRevalidate(route.page) ?? 60),
          passQuery: true,
        },
        exact: !DYNAMIC_SEGMENT_RE.test(route.pattern),
        functionName: functionNameForPath(physicalPattern, route.mode),
        pattern: physicalPattern,
        source,
      });
    }
  }

  for (let appIndex = 0; appIndex < apps.length; appIndex += 1) {
    const app = apps[appIndex] as RuntimeTargetApp;
    const build = builds[appIndex] as RuntimeAppBuild;
    for (const prerender of build.ssgPrerenders) {
      if (hasRequestLoader(app, prerender)) {
        continue;
      }
      const routePath = physicalPath(app.prefix, prerender.path);
      const genericSource = routePatternSource(app.prefix, prerender.route.pattern);
      let spec = specs.get(genericSource) as PrerenderSpec;
      if (DYNAMIC_SEGMENT_RE.test(prerender.route.pattern)) {
        const source = exactPathSource(routePath);
        spec = {
          config: { expiration: false, passQuery: true },
          exact: true,
          functionName: functionNameForPath(routePath, "ssg"),
          pattern: routePath,
          source,
        };
        specs.set(source, spec);
      }
      // biome-ignore lint/performance/noAwaitInLoops: each fallback may consume a unique redirect response body.
      await addSsgFallback(spec, routePath, prerender, functionsDir);
    }
  }

  return [...specs.values()].toSorted((left, right) => {
    if (left.exact !== right.exact) {
      return left.exact ? -1 : 1;
    }
    return compareRouteSpecificity(right.pattern, left.pattern);
  });
}

function vercelEntrySource(builds: RuntimeAppBuild[], serverEntry: string): string {
  const contextSource = buildEntrySource({
    apps: builds.map(({ entryApp, indexHtml }) => ({
      ...entryApp,
      embed: undefined,
      serveAssets: false,
      templateHtml: indexHtml,
    })),
    headerComment: "// Auto-generated by `furin build --target vercel` — do not edit",
  });
  return `import { invalidateByTag, waitUntil } from ${JSON.stringify(VERCEL_FUNCTIONS_PATH)};
import { setCachePurger } from "@teyik0/furin";
import { waitForPendingISRRevalidations } from "@teyik0/furin/internal";

${contextSource}

setCachePurger(async (paths) => {
  const purge = invalidateByTag(paths);
  waitUntil(purge);
  await purge;
});

const serverModule = await import(${JSON.stringify(toPosixPath(serverEntry))});
const app = serverModule.default;
if (!app || typeof app.handle !== "function") {
  throw new TypeError("[furin] Vercel server entry must export the Elysia app as default.");
}

function restorePrerenderPath(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get(${JSON.stringify(ISR_PATH_PARAM)});
  if (path === null) {
    return request;
  }
  url.pathname = path;
  url.searchParams.delete(${JSON.stringify(ISR_PATH_PARAM)});
  return new Request(url, request);
}

function exposeVercelCacheTag(response, request) {
  const cacheTag = response.headers.get("cache-tag");
  if (cacheTag === null) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete("cache-tag");
  headers.set("vercel-cache-tag", new URL(request.url).pathname);
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function handle(request) {
  const restoredRequest = restorePrerenderPath(request);
  const response = await app.handle(restoredRequest);
  waitUntil(waitForPendingISRRevalidations());
  return exposeVercelCacheTag(response, restoredRequest);
}

export default { fetch: handle };
`;
}

export async function buildVercelTarget(
  apps: RuntimeTargetApp[],
  rootDir: string,
  buildRoot: string,
  serverEntry: string,
  options: BuildAppOptions
): Promise<VercelTargetBuildManifest> {
  assertDefaultServerExport(serverEntry);

  const targetDir = join(buildRoot, "vercel");
  const outputDir = join(rootDir, ".vercel", "output");
  const staticDir = join(outputDir, "static");
  const functionsDir = join(outputDir, "functions");
  const serverFunctionDir = join(functionsDir, "__server.func");
  rmSync(targetDir, { force: true, recursive: true });
  rmSync(outputDir, { force: true, recursive: true });
  ensureDir(targetDir);
  ensureDir(staticDir);
  ensureDir(serverFunctionDir);

  const { builds, headlineBuildId } = await buildRuntimeAppsSequentially(
    apps,
    targetDir,
    serverEntry,
    options,
    "vercel"
  );

  for (let appIndex = 0; appIndex < apps.length; appIndex += 1) {
    const app = apps[appIndex] as RuntimeTargetApp;
    const build = builds[appIndex] as RuntimeAppBuild;
    const clientOutputDir = join(staticDir, app.prefix.slice(1), "_client");
    cpSync(build.clientDir, clientOutputDir, { recursive: true });
  }
  const publicDir = join(rootDir, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, staticDir, { recursive: true });
  }

  const entryPath = join(serverFunctionDir, "_vercel-entry.ts");
  const entry = createVirtualBuildEntry(entryPath, vercelEntrySource(builds, serverEntry), "ts");
  await runBunBuild({
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    entrypoints: [entry.entrypoint],
    files: entry.files,
    format: "esm",
    minify: true,
    naming: { entry: "index.[ext]" },
    outdir: serverFunctionDir,
    plugins: [
      entry.plugin,
      ...(options.plugins ?? []),
      createRoutesPlugin({ instances: apps, target: "server" }),
      isomorphicTransformPlugin("server"),
      environmentGuardPlugin("ssr"),
    ],
    sourcemap: "none",
    target: "bun",
  });

  writeFileSync(
    join(serverFunctionDir, ".vc-config.json"),
    `${JSON.stringify(
      {
        handler: "index.js",
        launcherType: "Nodejs",
        runtime: "bun1.4.x",
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
      },
      null,
      2
    )}\n`
  );

  const prerenderSpecs = await createPrerenderSpecs(apps, builds, functionsDir);
  for (const spec of prerenderSpecs) {
    createFunctionAlias(functionsDir, serverFunctionDir, spec.functionName);
    writeFileSync(
      join(functionsDir, `${spec.functionName}.prerender-config.json`),
      `${JSON.stringify(spec.config, null, 2)}\n`
    );
  }

  const assetRoutes: VercelRoute[] = apps.map((app) => ({
    continue: true,
    headers: { "cache-control": "public, max-age=31536000, immutable" },
    src: `${escapeRegex(app.prefix)}/_client/(.*)`,
  }));
  const config: VercelBuildOutputConfig = {
    framework: { name: "furin", version: frameworkVersion() },
    routes: [
      ...assetRoutes,
      { handle: "filesystem" },
      ...prerenderSpecs.map((spec) => ({
        dest: destinationForFunction(spec.functionName),
        src: spec.source,
      })),
      { dest: "/__server", src: "/(.*)" },
    ],
    version: 3,
  };
  writeFileSync(join(outputDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const ssgRoutes = builds
    .flatMap((build, index) =>
      build.ssgPrerenders.map((prerender) =>
        physicalPath((apps[index] as RuntimeTargetApp).prefix, prerender.path)
      )
    )
    .toSorted();
  const isrRoutes = apps
    .flatMap((app) =>
      app.routes
        .filter((route) => route.mode === "isr")
        .map((route) => physicalPath(app.prefix, route.pattern))
    )
    .toSorted();

  console.log(`[furin] Vercel output: ${toPosixPath(relative(rootDir, outputDir))}`);
  return {
    buildId: headlineBuildId,
    generatedAt: new Date().toISOString(),
    isrRoutes,
    outputDir: toPosixPath(relative(rootDir, outputDir)),
    serverPath: toPosixPath(relative(rootDir, serverFunctionDir)),
    ssgRoutes,
  };
}
