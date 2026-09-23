import { cpSync, existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBunBuild } from "../build/bun-build.ts";
import { elysiaAot } from "../build/elysia-aot.ts";
import { productionInstrumentationPlugin } from "../build/production-instrumentation.ts";
import { materializeServerAppEntry } from "../build/server-app-entry.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { RoutePrerender } from "../build/ssg-cache.ts";
import type { BuildAppOptions, VercelTargetBuildManifest } from "../build/types.ts";
import { createVirtualBuildEntry } from "../build/virtual-entry.ts";
import { createRoutesPlugin } from "../plugin/routes.ts";
import { isomorphicTransformPlugin } from "../plugin/transform-isomorphic.ts";
import { environmentGuardPlugin } from "../rsc/build/environment.ts";
import { hasRequestLoader } from "../server/render/loaders.ts";
import { compareRouteSpecificity, resolveRouteRevalidate } from "../server/router/patterns.ts";
import type { ResolvedRoute } from "../server/router/types.ts";
import { physicalPath } from "../shared/prefix.ts";
import {
  buildRuntimeAppsSequentially,
  pprRuntimePlugin,
  type RuntimeAppBuild,
  type RuntimeTargetApp,
} from "./runtime-build.ts";

const ISR_PATH_PARAM = "__furin_path";
const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;
const ELYSIA_STATIC_IMPORT_RE = /^@elysia\/static$/;
const MATCH_ALL_RE = /.*/;
const REGEX_META_RE = /[.*+?^${}()|[\]\\]/;
const UNSAFE_FUNCTION_PATH_RE = /[^a-zA-Z0-9_.[\]/-]/g;
const VERCEL_FUNCTIONS_PATH = fileURLToPath(import.meta.resolve("@vercel/functions"));
const VERCEL_RUNTIME_STUB_NAMESPACE = "furin-vercel-runtime-stub";
const FURIN_RUNTIME_ROOT = dirname(import.meta.dir);

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
  chain?: { outputPath: string; headers: { "x-furin-ppr-resume": string } };
  expiration: number | false;
  fallback?: string;
  initialHeaders?: {
    "cache-control"?: string;
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

function vercelRuntimePlugin(): Bun.BunPlugin {
  return {
    name: "furin-vercel-runtime",
    setup(build) {
      build.onResolve({ filter: ELYSIA_STATIC_IMPORT_RE }, ({ importer }) => {
        if (!isFurinRuntimeImporter(importer)) {
          throw new Error(
            "[furin] Application @elysia/static mounts are not supported by the Vercel target. Put CDN assets under public/ instead."
          );
        }
        return {
          namespace: VERCEL_RUNTIME_STUB_NAMESPACE,
          path: "@elysia/static",
        };
      });
      build.onLoad({ filter: MATCH_ALL_RE, namespace: VERCEL_RUNTIME_STUB_NAMESPACE }, () => ({
        contents: `export function staticPlugin() {
  throw new Error("[furin] The Vercel CDN owns production assets.");
}`,
        loader: "js",
      }));
    },
  };
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
  const { exports, imports } = transpiler.scan(readFileSync(serverEntry, "utf8"));
  if (!exports.includes("default")) {
    throw new Error(
      `[furin] Vercel server entry "${toPosixPath(serverEntry)}" must export the Elysia app as default. ` +
        "Guard app.listen() with `if (import.meta.main)` so the same entry also runs locally."
    );
  }
  if (imports.some(({ path }) => ELYSIA_STATIC_IMPORT_RE.test(path))) {
    throw new AggregateError(
      [
        new Error(
          "[furin] Application @elysia/static mounts are not supported by the Vercel target. Put CDN assets under public/ instead."
        ),
      ],
      "[furin] Vercel build rejected application static mounts."
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

function encodeCacheTag(value: string): string {
  return value.replaceAll(",", "%2C");
}

function cacheTagHeader(path: string, tags: readonly string[] | undefined): string {
  return [path, ...(tags ?? [])].map(encodeCacheTag).join(",");
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

function isPprRoute(app: RuntimeTargetApp, route: ResolvedRoute): boolean {
  return (
    route.mode !== "ssr" && (app.root.route.requestLoader !== undefined || hasRequestLoader(route))
  );
}

async function addPrerenderFallback(
  spec: PrerenderSpec,
  physicalRoutePath: string,
  prerender: RoutePrerender,
  functionsDir: string
): Promise<void> {
  const fallback = `${basename(spec.functionName)}.prerender-fallback.html`;
  const { result } = prerender;
  if (result === undefined) {
    return;
  }
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
    ...(spec.config.chain === undefined ? {} : { "cache-control": "private, no-store" }),
    ...(location === undefined ? {} : { location }),
    "vercel-cache-tag": cacheTagHeader(physicalRoutePath, prerender.route.tags),
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

function createExactPrerenderSpec(
  prerender: RoutePrerender,
  routePath: string
): PrerenderSpec | undefined {
  if (!DYNAMIC_SEGMENT_RE.test(prerender.route.pattern)) {
    return;
  }
  const { mode } = prerender.route;
  if (mode === "ssr") {
    return;
  }
  const source = exactPathSource(routePath);
  return {
    config: {
      expiration: mode === "ssg" ? false : (resolveRouteRevalidate(prerender.route.page) ?? 60),
      passQuery: true,
    },
    exact: true,
    functionName: functionNameForPath(routePath, mode),
    pattern: routePath,
    source,
  };
}

async function createPrerenderSpecs(
  apps: RuntimeTargetApp[],
  builds: RuntimeAppBuild[],
  functionsDir: string,
  pprResumeKey: string
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
          ...(isPprRoute(app, route)
            ? {
                chain: { headers: { "x-furin-ppr-resume": pprResumeKey }, outputPath: "__server" },
              }
            : {}),
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
    for (const prerender of build.prerenders) {
      const routePath = physicalPath(app.prefix, prerender.path);
      const genericSource = routePatternSource(app.prefix, prerender.route.pattern);
      let spec = specs.get(genericSource) as PrerenderSpec;
      const exactSpec = createExactPrerenderSpec(prerender, routePath);
      if (exactSpec !== undefined) {
        exactSpec.config.chain = spec.config.chain;
        spec = exactSpec;
        specs.set(exactSpec.source, exactSpec);
      }
      // biome-ignore lint/performance/noAwaitInLoops: each fallback may consume a unique redirect response body.
      await addPrerenderFallback(spec, routePath, prerender, functionsDir);
    }
  }

  return [...specs.values()].toSorted((left, right) => {
    if (left.exact !== right.exact) {
      return left.exact ? -1 : 1;
    }
    return compareRouteSpecificity(right.pattern, left.pattern);
  });
}

function vercelEntrySource(
  apps: RuntimeTargetApp[],
  builds: RuntimeAppBuild[],
  prerenderSpecs: PrerenderSpec[],
  appEntry: string,
  pprResumeKey: string
): string {
  const routeCount = builds.reduce((count, build) => count + build.entryApp.routes.length, 0);
  const prerenderAliases = prerenderSpecs.map((spec) => [
    `/${spec.functionName}`,
    `^(?:${spec.source})$`,
  ]);
  const dataEndpointPaths = builds.map(({ entryApp }) => `${entryApp.prefix}/_furin/data`);
  const pprBuilds = apps
    .map((app, index) => ({
      buildId: (builds[index] as RuntimeAppBuild).buildId,
      patterns: app.routes
        .filter((route) => isPprRoute(app, route))
        .map((route) => `^(?:${routePatternSource(app.prefix, route.pattern)})$`),
      prefix: app.prefix,
    }))
    .filter((build) => build.patterns.length > 0);
  const cacheTagRules = apps
    .flatMap((app) =>
      app.routes.map((route) => ({
        pattern: physicalPath(app.prefix, route.pattern),
        source: `^(?:${routePatternSource(app.prefix, route.pattern)})$`,
        tags: route.tags ?? [],
      }))
    )
    .sort((left, right) => compareRouteSpecificity(right.pattern, left.pattern))
    .map(({ source, tags }) => [source, tags]);
  return `import {
  addCacheTag,
  getCache as getVercelCache,
  invalidateByTag,
  waitUntil,
} from ${JSON.stringify(VERCEL_FUNCTIONS_PATH)};
import { setCachePurger } from "@teyik0/furin";
import {
  hasPendingISRRevalidations,
  markExternalPrerenderRequest,
  restorePprResumeRequest,
  setCacheTagPurger,
  setRuntimeCacheProvider,
  waitForPendingISRRevalidations,
} from "@teyik0/furin/internal";

const prerenderAliases = new Map(
  ${JSON.stringify(prerenderAliases)}.map(([alias, source]) => [alias, new RegExp(source)])
);
const dataEndpointPaths = new Set(${JSON.stringify(dataEndpointPaths)});
${
  pprBuilds.length === 0
    ? ""
    : `const pprBuilds = ${JSON.stringify(pprBuilds)}.map(build => ({
  ...build, patterns: build.patterns.map(source => new RegExp(source))
}));`
}
const cacheTagRules = ${JSON.stringify(cacheTagRules)}.map(([source, tags]) => [
  new RegExp(source),
  tags,
]);

function encodeCacheTag(value) {
  return value.replaceAll(",", "%2C");
}

setRuntimeCacheProvider({
  getCache: (options) => getVercelCache(options),
});

async function purgeCacheTags(paths) {
  const purge = Promise.all([
    invalidateByTag(paths.map(encodeCacheTag)),
    getVercelCache().expireTag(paths),
  ]);
  waitUntil(purge);
  await purge;
}
setCachePurger(purgeCacheTags);
setCacheTagPurger(purgeCacheTags);

const serverInitStartedAt = performance.now();
const serverModule = await import(${JSON.stringify(toPosixPath(appEntry))});
const app = serverModule.default;
if (!app || typeof app.handle !== "function") {
  throw new TypeError("[furin] Vercel server entry must export the Elysia app as default.");
}
const initialization = Object.freeze({
  app_count: ${builds.length},
  route_count: ${routeCount},
  server_init_ms: Math.round((performance.now() - serverInitStartedAt) * 100) / 100,
});

function restorePrerenderPath(request) {
  const url = new URL(request.url);
  const path = url.searchParams.get(${JSON.stringify(ISR_PATH_PARAM)});
  const aliasPattern = prerenderAliases.get(url.pathname);
  if (path === null || aliasPattern === undefined || !aliasPattern.test(path)) {
    return request;
  }
  if (!path.startsWith("/")) {
    return request;
  }
  url.pathname = path;
  url.searchParams.delete(${JSON.stringify(ISR_PATH_PARAM)});
  return markExternalPrerenderRequest(new Request(url, request));
}

async function exposeVercelCacheTag(response, request) {
  const cacheTag = response.headers.get("cache-tag");
  if (cacheTag === null) {
    return response;
  }
  const requestPath = new URL(request.url).pathname;
  const dataSuffix = "/_furin/data";
  const prefix = dataEndpointPaths.has(requestPath)
    ? requestPath.slice(0, -dataSuffix.length)
    : null;
  const physicalCacheTag =
    prefix === null ? requestPath : cacheTag === "/" ? prefix || "/" : prefix + cacheTag;
  const semanticTags =
    cacheTagRules.find(([pattern]) => pattern.test(physicalCacheTag))?.[1] ?? [];
  const tags = [physicalCacheTag, ...semanticTags].map(encodeCacheTag);
  await addCacheTag(tags);
  const headers = new Headers(response.headers);
  headers.delete("cache-tag");
  headers.set("vercel-cache-tag", tags.join(","));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function handle(request) {
  ${
    pprBuilds.length === 0
      ? ""
      : `if (request.headers.has("x-furin-ppr-resume")) {
    if (request.method !== "POST" || request.headers.get("x-furin-ppr-resume") !== ${JSON.stringify(pprResumeKey)}) {
      return new Response("Invalid PPR continuation", { status: 403 });
    }
    const restored = await restorePprResumeRequest(request, pprBuilds);
    if (restored instanceof Response) return restored;
    return app.handle(restored);
  }`
  }
  const restoredRequest = restorePrerenderPath(request);
  const response = await app.handle(restoredRequest);
  if (hasPendingISRRevalidations()) {
    waitUntil(waitForPendingISRRevalidations());
  }
  return exposeVercelCacheTag(response, restoredRequest);
}

export { initialization };
export default { fetch: handle };
`;
}

async function buildPprFallbacks(
  apps: RuntimeTargetApp[],
  builds: RuntimeAppBuild[],
  specs: PrerenderSpec[],
  functionsDir: string,
  rootDir: string,
  targetDir: string
): Promise<void> {
  const jobs = builds.flatMap((build, index) =>
    build.prerenders
      .filter((prerender) => prerender.result === undefined)
      .map((prerender) => {
        const path = physicalPath((apps[index] as RuntimeTargetApp).prefix, prerender.path);
        const spec = specs.find(
          (candidate) =>
            candidate.config.chain !== undefined &&
            new RegExp(`^(?:${candidate.source})$`).test(path)
        );
        if (!spec) {
          throw new Error(`[furin] Missing PPR build target for ${path}`);
        }
        return { path, prerender, spec };
      })
  );
  if (jobs.length === 0) {
    return;
  }
  const resultPath = join(targetDir, "ppr-results.json");
  const requests = jobs.map(
    ({ path, spec }) =>
      `http://localhost/${spec.functionName}?${ISR_PATH_PARAM}=${encodeURIComponent(path)}`
  );
  const script = `
const handler = (await import(${JSON.stringify(pathToFileURL(join(functionsDir, "__server.func/index.js")).href)})).default;
const results = [];
for (const url of ${JSON.stringify(requests)}) {
  const response = await handler.fetch(new Request(url));
  if (response.status >= 400) throw new Error("PPR build failed for " + url + ": HTTP " + response.status);
  results.push({ body: await response.text(), headers: Object.fromEntries(response.headers), status: response.status });
}
await Bun.write(${JSON.stringify(resultPath)}, JSON.stringify(results));
process.exit(0);
`;
  const child = Bun.spawn([process.execPath, "-e", script], {
    cwd: rootDir,
    env: { ...process.env, RUNTIME_CACHE_DISABLE_BUILD_CACHE: "true" },
    stderr: "pipe",
    stdout: "pipe",
  });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) {
      throw new Error(`[furin] PPR production prerender failed:\n${stderr}\n${stdout}`);
    }
    const results = JSON.parse(readFileSync(resultPath, "utf8")) as {
      body: string;
      headers: { [name: string]: string };
      status: number;
    }[];
    for (const [index, job] of jobs.entries()) {
      const result = results[index] as (typeof results)[number];
      // biome-ignore lint/performance/noAwaitInLoops: consume and write each fallback in route order.
      await addPrerenderFallback(
        job.spec,
        job.path,
        {
          ...job.prerender,
          result: new Response(result.body, { headers: result.headers, status: result.status }),
        },
        functionsDir
      );
    }
  } finally {
    rmSync(resultPath, { force: true });
  }
}

function vercelBootstrapSource(serverBundleBytes: number): string {
  return `const moduleInitStartedAt = performance.now();
const handlerPromise = import("./handler.js").then((handlerModule) => ({
  handlerModule,
  moduleInitMs: Math.round((performance.now() - moduleInitStartedAt) * 100) / 100,
}));
let firstRequest = true;

function appendServerTiming(response, value) {
  try {
    response.headers.append("server-timing", value);
    return response;
  } catch {
    if (response.status === 101) {
      return response;
    }
    const headers = new Headers(response.headers);
    headers.append("server-timing", value);
    return new Response(response.body, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }
}

async function handle(request) {
  const waitStartedAt = performance.now();
  const ready = await handlerPromise;
  const requestWaitMs = Math.round((performance.now() - waitStartedAt) * 100) / 100;
  const isFirstRequest = firstRequest;
  firstRequest = false;
  const { initialization } = ready.handlerModule;

  if (isFirstRequest) {
    console.log(JSON.stringify({
      environment: process.env.VERCEL_ENV ?? "production",
      event: "vercel_cold_start",
      furin: {
        app_count: initialization.app_count,
        module_init_ms: ready.moduleInitMs,
        request_wait_ms: requestWaitMs,
        route_count: initialization.route_count,
        server_bundle_bytes: ${serverBundleBytes},
        server_init_ms: initialization.server_init_ms,
      },
      level: "info",
      region: process.env.VERCEL_REGION,
      service: "furin",
    }));
  }

  const handlerStartedAt = performance.now();
  const response = await ready.handlerModule.default.fetch(request);
  const handlerMs = Math.round((performance.now() - handlerStartedAt) * 100) / 100;
  const serverTiming = [
    \`furin_module_init;dur=\${ready.moduleInitMs}\`,
    \`furin_server_init;dur=\${initialization.server_init_ms}\`,
    \`furin_handler_wait;dur=\${requestWaitMs}\`,
    \`furin_handler;dur=\${handlerMs}\`,
  ].join(", ");
  return appendServerTiming(response, serverTiming);
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
    rootDir,
    targetDir,
    serverEntry,
    options,
    "vercel"
  );

  cpSync(join(targetDir, "server-codec.js"), join(serverFunctionDir, "server-codec.js"));

  const publicDir = join(rootDir, "public");
  if (existsSync(publicDir)) {
    cpSync(publicDir, staticDir, { recursive: true });
    for (const app of apps) {
      const appStaticDir = join(staticDir, app.prefix.slice(1));
      const appPublicDir = join(appStaticDir, "public");
      cpSync(publicDir, appPublicDir, { recursive: true });
      const favicon = join(publicDir, "favicon.ico");
      if (app.prefix !== "" && existsSync(favicon)) {
        cpSync(favicon, join(appStaticDir, "favicon.ico"));
      }
    }
  }
  for (let appIndex = 0; appIndex < apps.length; appIndex += 1) {
    const app = apps[appIndex] as RuntimeTargetApp;
    const build = builds[appIndex] as RuntimeAppBuild;
    const clientOutputDir = join(staticDir, app.prefix.slice(1), "_client");
    cpSync(build.clientDir, clientOutputDir, { recursive: true });
  }

  const pprResumeKey = crypto.randomUUID();
  const prerenderSpecs = await createPrerenderSpecs(apps, builds, functionsDir, pprResumeKey);
  const appEntry = await materializeServerAppEntry({
    apps: builds.map(({ entryApp, indexHtml }) => ({
      ...entryApp,
      embed: undefined,
      serveAssets: false,
      templateHtml: indexHtml,
    })),
    headerComment: "// Auto-generated by `furin build --target vercel` — do not edit",
    instances: apps,
    outDir: serverFunctionDir,
    serverEntry,
  });
  const entryPath = join(serverFunctionDir, "_vercel-handler.ts");
  const entry = createVirtualBuildEntry(
    entryPath,
    vercelEntrySource(apps, builds, prerenderSpecs, appEntry, pprResumeKey),
    "ts"
  );
  const serverBuild = await runBunBuild({
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    entrypoints: [entry.entrypoint],
    files: entry.files,
    format: "esm",
    metafile: options.analyze,
    minify: true,
    naming: { entry: "handler.[ext]" },
    outdir: serverFunctionDir,
    plugins: [
      entry.plugin,
      vercelRuntimePlugin(),
      productionInstrumentationPlugin(),
      pprRuntimePlugin(apps),
      ...(options.plugins ?? []),
      createRoutesPlugin({ instances: apps, target: "server" }),
      isomorphicTransformPlugin("server"),
      environmentGuardPlugin("ssr"),
      elysiaAot(appEntry),
    ],
    sourcemap: "none",
    splitting: true,
    target: "bun",
  });
  if (options.analyze) {
    if (serverBuild.metafile === undefined) {
      throw new Error("[furin] Vercel server build did not produce the requested metafile.");
    }
    const metafilePath = join(buildRoot, "analysis", "vercel-server.json");
    ensureDir(dirname(metafilePath));
    writeFileSync(metafilePath, `${JSON.stringify(serverBuild.metafile, null, 2)}\n`);
    console.log(`[furin] Server metafile: ${toPosixPath(metafilePath)}`);
  }
  const serverBundleBytes = serverBuild.outputs
    .filter((output) => output.path.endsWith(".js"))
    .reduce((total, output) => total + output.size, 0);
  writeFileSync(join(serverFunctionDir, "index.js"), vercelBootstrapSource(serverBundleBytes));
  await buildPprFallbacks(apps, builds, prerenderSpecs, functionsDir, rootDir, targetDir);

  writeFileSync(
    join(serverFunctionDir, ".vc-config.json"),
    `${JSON.stringify(
      {
        handler: "index.js",
        launcherType: "Nodejs",
        ...(options.vercelConfig?.regions === undefined
          ? {}
          : { regions: options.vercelConfig.regions }),
        runtime: "bun1.4.x",
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
      },
      null,
      2
    )}\n`
  );

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
  const pageRoutes = [
    ...prerenderSpecs.map((spec) => ({
      dest: destinationForFunction(spec.functionName),
      pattern: spec.pattern,
      src: spec.source,
    })),
    ...apps.flatMap((app) =>
      app.routes
        .filter((route) => route.mode === "ssr")
        .map((route) => ({
          dest: "/__server",
          pattern: physicalPath(app.prefix, route.pattern),
          src: routePatternSource(app.prefix, route.pattern),
        }))
    ),
  ].sort((left, right) => compareRouteSpecificity(right.pattern, left.pattern));
  const config: VercelBuildOutputConfig = {
    framework: { name: "furin", version: frameworkVersion() },
    routes: [
      ...assetRoutes,
      { handle: "filesystem" },
      ...pageRoutes.map(({ dest, src }) => ({ dest, src })),
      { dest: "/__server", src: "/(.*)" },
    ],
    version: 3,
  };
  writeFileSync(join(outputDir, "config.json"), `${JSON.stringify(config, null, 2)}\n`);

  const ssgRoutes = builds
    .flatMap((build, index) =>
      build.prerenders
        .filter((prerender) => prerender.route.mode === "ssg")
        .map((prerender) => physicalPath((apps[index] as RuntimeTargetApp).prefix, prerender.path))
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
