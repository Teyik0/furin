import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runBunBuild } from "../build/bun-build.ts";
import { ensureDir, toPosixPath } from "../build/shared.ts";
import type { VercelTargetBuildManifest } from "../build/types.ts";
import {
  compareRouteSpecificity,
  escapeRegExp,
  routePatternRegexSource,
} from "../server/router/patterns.ts";
import { physicalPath } from "../shared/prefix.ts";
import { frameworkSourceModule } from "./runtime-build.ts";
import type { AdapterApp, AdapterBuildOutput, AdapterRoute, FurinAdapter } from "./types.ts";
import { ISR_PATH_PARAM, VERCEL_DATA_FILE, type VercelRuntimeData } from "./vercel/data.ts";

// https://vercel.com/docs/regions#region-list
const VERCEL_REGIONS = [
  "arn1",
  "bom1",
  "cdg1",
  "cle1",
  "cpt1",
  "dub1",
  "dxb1",
  "fra1",
  "gru1",
  "hkg1",
  "hnd1",
  "iad1",
  "icn1",
  "kix1",
  "lhr1",
  "pdx1",
  "sfo1",
  "sin1",
  "syd1",
  "yul1",
] as const;

export type VercelRegion = (typeof VERCEL_REGIONS)[number];

export interface VercelAdapterOptions {
  /** Vercel compute regions, such as "cdg1" or "iad1". Defaults to the project's region. */
  regions?: VercelRegion[];
}

const HANDLER_MODULE = frameworkSourceModule("adapter/vercel/handler.ts");
const BOOTSTRAP_MODULE = frameworkSourceModule("adapter/vercel/bootstrap.ts");
const HANDLER_IMPORT_RE = /^\.\/handler\.js$/;
const DYNAMIC_SEGMENT_RE = /\/:[^/]+|\/\*/;
const UNSAFE_FUNCTION_PATH_RE = /[^a-zA-Z0-9_.[\]/-]/g;

interface VercelRoute {
  continue?: boolean;
  dest?: string;
  handle?: "filesystem";
  has?: { key: string; type: "query"; value: string }[];
  headers?: { "cache-control": string };
  src?: string;
}

interface VercelBuildOutputConfig {
  framework: { name: "furin"; version: string };
  routes: VercelRoute[];
  version: 3;
}

interface PrerenderConfig {
  allowQuery?: string[];
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

/** A known URL the production Function renders into a Prerender fallback. */
interface FallbackJob {
  path: string;
  route: AdapterRoute;
  spec: PrerenderSpec;
}

function assertRegions(regions: VercelRegion[] | undefined): void {
  if (regions === undefined) {
    return;
  }
  const invalid = regions.find((region) => !(VERCEL_REGIONS as readonly string[]).includes(region));
  if (regions.length === 0 || new Set(regions).size !== regions.length || invalid !== undefined) {
    throw new Error(
      `[furin] vercel({ regions }) expects a non-empty list of distinct Vercel regions${invalid === undefined ? "" : ` (got "${invalid}")`}.`
    );
  }
}

function frameworkVersion(): string {
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.resolve("@teyik0/furin"))));
  const packageJson = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    version: string;
  };
  return packageJson.version;
}

function encodeCacheTag(value: string): string {
  return value.replaceAll(",", "%2C");
}

function cacheTagHeader(path: string, tags: readonly string[]): string {
  return [path, ...tags].map(encodeCacheTag).join(",");
}

function routePatternSource(prefix: string, pattern: string): string {
  const { source } = routePatternRegexSource(physicalPath(prefix, pattern), {
    catchAll: ".*",
    param: "[^/]+",
  });
  return `(?<${ISR_PATH_PARAM}>${source})`;
}

function exactPathSource(path: string): string {
  return `(?<${ISR_PATH_PARAM}>${escapeRegExp(path)})`;
}

function functionNameForPath(
  path: string,
  mode: "isr" | "ssg",
  names: Map<string, string>
): string {
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
  const base = `${normalized}-${mode}`;
  const identity = `${mode}:${path}`;
  let name = base;
  let suffix = 2;
  while (names.has(name) && names.get(name) !== identity) {
    name = `${base}-${suffix}`;
    suffix += 1;
  }
  names.set(name, identity);
  return name;
}

function destinationForFunction(functionName: string): string {
  return `/${functionName}?${ISR_PATH_PARAM}=$${ISR_PATH_PARAM}`;
}

function expirationFor(route: AdapterRoute): number | false {
  return route.mode === "ssg" ? false : (route.revalidate ?? 60);
}

/**
 * Query names Vercel may key a prerender on. Without `allowQuery` every unique
 * query string becomes its own cache entry, so keep only the internal path
 * param plus the route's declared query keys. Non-TypeBox query schemas cannot
 * be enumerated; they keep Vercel's per-query caching rather than collapsing
 * distinct declared values into one entry.
 */
function prerenderAllowQuery(route: AdapterRoute): string[] | undefined {
  return route.queryKeys === null ? undefined : [ISR_PATH_PARAM, ...route.queryKeys];
}

function createPrerenderSpecs(
  apps: AdapterApp[],
  pprResumeKey: string
): { jobs: FallbackJob[]; specs: PrerenderSpec[] } {
  const specs = new Map<string, PrerenderSpec>();
  const names = new Map<string, string>();
  const jobs: FallbackJob[] = [];

  for (const app of apps) {
    for (const route of app.routes) {
      if (route.mode === "ssr") {
        continue;
      }
      const physicalPattern = physicalPath(app.prefix, route.pattern);
      const source = routePatternSource(app.prefix, route.pattern);
      specs.set(source, {
        config: {
          // PPR holes resume with the query the shell recorded, which is the
          // canonical declared query, so PPR shells share the same keys.
          allowQuery: prerenderAllowQuery(route),
          expiration: expirationFor(route),
          passQuery: true,
          ...(route.ppr
            ? {
                chain: { headers: { "x-furin-ppr-resume": pprResumeKey }, outputPath: "__server" },
              }
            : {}),
        },
        exact: !DYNAMIC_SEGMENT_RE.test(route.pattern),
        functionName: functionNameForPath(physicalPattern, route.mode, names),
        pattern: physicalPattern,
        source,
      });
    }
  }

  for (const app of apps) {
    for (const prerender of app.prerenders) {
      const route = app.routes.find((candidate) => candidate.pattern === prerender.pattern);
      if (route === undefined || route.mode === "ssr") {
        continue;
      }
      const path = physicalPath(app.prefix, prerender.path);
      let spec = specs.get(routePatternSource(app.prefix, route.pattern)) as PrerenderSpec;
      if (DYNAMIC_SEGMENT_RE.test(route.pattern)) {
        spec = {
          config: {
            allowQuery: spec.config.allowQuery,
            chain: spec.config.chain,
            expiration: expirationFor(route),
            passQuery: true,
          },
          exact: true,
          functionName: functionNameForPath(path, route.mode, names),
          pattern: path,
          source: exactPathSource(path),
        };
        specs.set(spec.source, spec);
      }
      jobs.push({ path, route, spec });
    }
  }

  return {
    jobs,
    specs: [...specs.values()].toSorted((left, right) => {
      if (left.exact !== right.exact) {
        return left.exact ? -1 : 1;
      }
      return compareRouteSpecificity(right.pattern, left.pattern);
    }),
  };
}

function runtimeData(
  apps: AdapterApp[],
  specs: PrerenderSpec[],
  pprResumeKey: string,
  serverBundleBytes: number
): VercelRuntimeData {
  return {
    appCount: apps.length,
    cacheTagRules: apps
      .flatMap((app) =>
        app.routes.map((route) => ({
          pattern: physicalPath(app.prefix, route.pattern),
          source: `^(?:${routePatternSource(app.prefix, route.pattern)})$`,
          tags: route.tags,
        }))
      )
      .sort((left, right) => compareRouteSpecificity(right.pattern, left.pattern))
      .map(({ source, tags }) => [source, tags]),
    pprBuilds: apps
      .map((app) => ({
        buildId: app.buildId,
        patterns: app.routes
          .filter((route) => route.ppr)
          .map((route) => `^(?:${routePatternSource(app.prefix, route.pattern)})$`),
        prefix: app.prefix,
      }))
      .filter((build) => build.patterns.length > 0),
    pprResumeKey,
    prerenderAliases: specs.map((spec) => [`/${spec.functionName}`, `^(?:${spec.source})$`]),
    routeCount: apps.reduce((count, app) => count + app.routes.length, 0),
    serverBundleBytes,
  };
}

async function addPrerenderFallback(
  job: FallbackJob,
  response: Response,
  functionsDir: string
): Promise<void> {
  const { spec } = job;
  const fallback = `${basename(spec.functionName)}.prerender-fallback.html`;
  const location = response.headers.get("location") ?? undefined;
  const fallbackPath = join(dirname(join(functionsDir, spec.functionName)), fallback);
  ensureDir(dirname(fallbackPath));
  writeFileSync(fallbackPath, await response.text());
  spec.config.fallback = fallback;
  spec.config.initialHeaders = {
    "content-type": response.headers.get("content-type") ?? "text/html; charset=utf-8",
    ...(spec.config.chain === undefined ? {} : { "cache-control": "private, no-store" }),
    ...(location === undefined ? {} : { location }),
    "vercel-cache-tag": cacheTagHeader(job.path, job.route.tags),
  };
  spec.config.initialStatus = response.status;
}

/** Renders every known URL through the deployed Function code. */
async function buildProductionFallbacks(
  jobs: FallbackJob[],
  functionsDir: string,
  rootDir: string,
  buildRoot: string
): Promise<void> {
  if (jobs.length === 0) {
    return;
  }
  const resultPath = join(buildRoot, `vercel-prerender-${crypto.randomUUID()}.json`);
  const requests = jobs.map(
    ({ path, spec }) =>
      `http://localhost/${spec.functionName}?${ISR_PATH_PARAM}=${encodeURIComponent(path)}`
  );
  const script = `
const handler = (await import(${JSON.stringify(pathToFileURL(join(functionsDir, "__server.func/index.js")).href)})).default;
const results = [];
for (const [index, url] of ${JSON.stringify(requests)}.entries()) {
  const response = await handler.fetch(new Request(url));
  if (response.status >= 500 || (response.status >= 400 && ${JSON.stringify(jobs.map(({ spec }) => spec.config.chain !== undefined))}[index])) throw new Error("Production prerender failed for " + url + ": HTTP " + response.status);
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
      throw new Error(`[furin] Production prerender failed:\n${stderr}\n${stdout}`);
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
        job,
        new Response(result.body, { headers: result.headers, status: result.status }),
        functionsDir
      );
    }
  } finally {
    rmSync(resultPath, { force: true });
  }
}

/** Builds the typed bootstrap that lazily loads `handler.js`. */
async function buildBootstrap(serverFunctionDir: string): Promise<void> {
  await runBunBuild({
    entrypoints: [BOOTSTRAP_MODULE],
    format: "esm",
    minify: true,
    naming: "index.js",
    outdir: serverFunctionDir,
    plugins: [
      {
        name: "furin-vercel-handler-external",
        setup(build) {
          build.onResolve({ filter: HANDLER_IMPORT_RE }, ({ path }) => ({ external: true, path }));
        },
      },
    ],
    target: "bun",
  });
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

function copyStaticAssets(output: AdapterBuildOutput, staticDir: string): void {
  const { apps, publicDir } = output;
  if (publicDir !== undefined) {
    cpSync(publicDir, staticDir, { recursive: true });
    for (const app of apps) {
      const appStaticDir = join(staticDir, app.prefix.slice(1));
      cpSync(publicDir, join(appStaticDir, "public"), { recursive: true });
      const favicon = join(publicDir, "favicon.ico");
      if (app.prefix !== "" && existsSync(favicon)) {
        cpSync(favicon, join(appStaticDir, "favicon.ico"));
      }
    }
  }
  for (const app of apps) {
    cpSync(app.clientDir, join(staticDir, app.prefix.slice(1), "_client"), { recursive: true });
  }
}

function buildOutputConfig(apps: AdapterApp[], specs: PrerenderSpec[]): VercelBuildOutputConfig {
  const assetRoutes: VercelRoute[] = apps.map((app) => ({
    continue: true,
    headers: { "cache-control": "public, max-age=31536000, immutable" },
    src: `${escapeRegExp(app.prefix)}/_client/(.*)`,
  }));
  const pageRoutes = [
    ...specs.map((spec) => ({
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
  return {
    framework: { name: "furin", version: frameworkVersion() },
    routes: [
      ...assetRoutes,
      // Navigation data shares the page URL (`?_furin=data`); prerendered
      // documents ignore that param, so data requests go to the function.
      { dest: "/__server", has: [{ key: "_furin", type: "query", value: "data" }], src: "/(.*)" },
      { handle: "filesystem" },
      ...pageRoutes.map(({ dest, src }) => ({ dest, src })),
      { dest: "/__server", src: "/(.*)" },
    ],
    version: 3,
  };
}

function writeFunctionConfig(serverFunctionDir: string, regions: VercelRegion[] | undefined): void {
  writeFileSync(
    join(serverFunctionDir, ".vc-config.json"),
    `${JSON.stringify(
      {
        handler: "index.js",
        launcherType: "Nodejs",
        ...(regions === undefined ? {} : { regions }),
        runtime: "bun1.4.x",
        shouldAddHelpers: false,
        supportsResponseStreaming: true,
      },
      null,
      2
    )}\n`
  );
}

/**
 * Vercel Build Output API v3 in `.vercel/output`: CDN assets, one Bun
 * Function, and Prerender Functions that own SSG, ISR and PPR caching.
 */
export function vercel(options: VercelAdapterOptions): FurinAdapter {
  assertRegions(options.regions);
  return {
    capabilities: { assets: "platform", publicCache: "platform", websocket: false },
    name: "vercel",
    async onBuildComplete(output): Promise<VercelTargetBuildManifest> {
      const { apps, rootDir, server } = output;
      const outputDir = join(rootDir, ".vercel", "output");
      const staticDir = join(outputDir, "static");
      const functionsDir = join(outputDir, "functions");
      const serverFunctionDir = join(functionsDir, "__server.func");
      rmSync(outputDir, { force: true, recursive: true });
      ensureDir(staticDir);
      ensureDir(serverFunctionDir);

      for (const file of [...server.files, "server-codec.js"]) {
        cpSync(join(server.dir, file), join(serverFunctionDir, file));
      }
      copyStaticAssets(output, staticDir);

      const pprResumeKey = crypto.randomUUID();
      const { jobs, specs } = createPrerenderSpecs(apps, pprResumeKey);
      const serverBundleBytes = server.files.reduce(
        (total, file) => total + statSync(join(server.dir, file)).size,
        0
      );
      writeFileSync(
        join(serverFunctionDir, VERCEL_DATA_FILE),
        `${JSON.stringify(runtimeData(apps, specs, pprResumeKey, serverBundleBytes))}\n`
      );
      await buildBootstrap(serverFunctionDir);
      await buildProductionFallbacks(jobs, functionsDir, rootDir, output.buildRoot);

      writeFunctionConfig(serverFunctionDir, options.regions);
      for (const spec of specs) {
        createFunctionAlias(functionsDir, serverFunctionDir, spec.functionName);
        writeFileSync(
          join(functionsDir, `${spec.functionName}.prerender-config.json`),
          `${JSON.stringify(spec.config, null, 2)}\n`
        );
      }
      writeFileSync(
        join(outputDir, "config.json"),
        `${JSON.stringify(buildOutputConfig(apps, specs), null, 2)}\n`
      );

      console.log(`[furin] Vercel output: ${toPosixPath(relative(rootDir, outputDir))}`);
      return {
        buildId: output.buildId,
        generatedAt: new Date().toISOString(),
        isrRoutes: apps
          .flatMap((app) =>
            app.routes
              .filter((route) => route.mode === "isr")
              .map((route) => physicalPath(app.prefix, route.pattern))
          )
          .toSorted(),
        outputDir: toPosixPath(relative(rootDir, outputDir)),
        serverPath: toPosixPath(relative(rootDir, serverFunctionDir)),
        ssgRoutes: jobs
          .filter((job) => job.route.mode === "ssg")
          .map((job) => job.path)
          .toSorted(),
      };
    },
    runtimeModule: HANDLER_MODULE,
  };
}
