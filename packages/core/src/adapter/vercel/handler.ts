// Runtime module of the Vercel adapter, bundled as `__server.func/handler.js`.
// Vercel invokes `fetch(Request)`; the module connects Furin's cache
// invalidation, background work and PPR continuations to the platform.
import {
  addCacheTag,
  getCache as getVercelCache,
  invalidateByTag,
  waitUntil,
} from "@vercel/functions";
import { setCachePurger } from "../../server/cache/invalidation.ts";
import {
  hasPendingISRRevalidations,
  markExternalPrerenderRequest,
  restorePprResumeRequest,
  setCacheTagPurger,
  setRuntimeCacheProvider,
  setRuntimeEvlogWaitUntil,
  waitForPendingISRRevalidations,
} from "../../server/internal.ts";
import { ISR_PATH_PARAM, VERCEL_DATA_FILE, type VercelRuntimeData } from "./data.ts";

const PPR_RESUME_HEADER = "x-furin-ppr-resume";

const data = (await Bun.file(
  new URL(`./${VERCEL_DATA_FILE}`, import.meta.url)
).json()) as VercelRuntimeData;
const prerenderAliases = new Map(
  data.prerenderAliases.map(([alias, source]) => [alias, new RegExp(source)] as const)
);
const pprBuilds = data.pprBuilds.map((build) => ({
  ...build,
  patterns: build.patterns.map((source) => new RegExp(source)),
}));
const cacheTagRules = data.cacheTagRules.map(
  ([source, tags]) => [new RegExp(source), tags] as const
);

function encodeCacheTag(value: string): string {
  return value.replaceAll(",", "%2C");
}

// Providers are installed before the application module evaluates, so its
// furin() mounts already see Vercel's caches.
setRuntimeCacheProvider({
  getCache: (options) => getVercelCache(options),
  scope: process.env.VERCEL_DEPLOYMENT_ID,
});
setRuntimeEvlogWaitUntil(waitUntil);

async function purgeCacheTags(paths: string[]): Promise<void> {
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
const { default: app } = await import("furin:app");
if (!app || typeof app.handle !== "function") {
  throw new TypeError("[furin] Vercel server entry must export the Elysia app as default.");
}
const application = app;
// `handle` neither waits for pending async plugins nor fails after one
// rejected: settle them at cold start so a failure fails the initialization.
await application.modules;

export const initialization = Object.freeze({
  app_count: data.appCount,
  route_count: data.routeCount,
  server_init_ms: Math.round((performance.now() - serverInitStartedAt) * 100) / 100,
});

/** Prerender Functions receive the original path in a query parameter. */
function restorePrerenderPath(request: Request): Request {
  const url = new URL(request.url);
  const path = url.searchParams.get(ISR_PATH_PARAM);
  const aliasPattern = prerenderAliases.get(url.pathname);
  if (path === null || aliasPattern === undefined || !aliasPattern.test(path)) {
    return request;
  }
  if (!path.startsWith("/")) {
    return request;
  }
  url.pathname = path;
  url.searchParams.delete(ISR_PATH_PARAM);
  return markExternalPrerenderRequest(new Request(url, request));
}

async function exposeVercelCacheTag(response: Response, request: Request): Promise<Response> {
  const cacheTag = response.headers.get("cache-tag");
  if (cacheTag === null) {
    return response;
  }
  const physicalCacheTag = new URL(request.url).pathname;
  const semanticTags = cacheTagRules.find(([pattern]) => pattern.test(physicalCacheTag))?.[1] ?? [];
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

async function resumePpr(request: Request): Promise<Response> {
  if (request.method !== "POST" || request.headers.get(PPR_RESUME_HEADER) !== data.pprResumeKey) {
    return new Response("Invalid PPR continuation", { status: 403 });
  }
  const restored = await restorePprResumeRequest(request, pprBuilds);
  return restored instanceof Response ? restored : application.handle(restored);
}

async function handle(request: Request): Promise<Response> {
  if (pprBuilds.length > 0 && request.headers.has(PPR_RESUME_HEADER)) {
    return resumePpr(request);
  }
  const restoredRequest = restorePrerenderPath(request);
  const response = await application.handle(restoredRequest);
  if (hasPendingISRRevalidations()) {
    waitUntil(waitForPendingISRRevalidations());
  }
  return exposeVercelCacheTag(response, restoredRequest);
}

export default { fetch: handle };
