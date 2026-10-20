import type { Context } from "elysia";
import type {
  RuntimeData,
  RuntimePage,
  RuntimeRoute,
} from "../../client/internal/runtime-types.ts";
import type { FurinNotFoundError } from "../../shared/not-found.ts";
import { ROUTE_MATCHES_KEY } from "../../shared/route-matches.ts";
import { canonicalCacheRequest } from "../cache/route-cache.ts";
import { getLogger } from "../context-logger.ts";
import { resolveRouteRevalidate } from "../router/patterns.ts";
import type { ResolvedRoute } from "../router/types.ts";
import { captureQueryReads } from "../sync/query-context.ts";
import { isHttpRedirect, normalizeLoaderError } from "./loader-errors.ts";
import {
  flattenSegments,
  mergeParentData,
  NO_SEGMENT_DATA,
  type SegmentData,
  splitOneLoaderResult,
} from "./loader-segments.ts";
import { cacheMixedPublicLoader } from "./mixed-cache.ts";
import { observeLoader } from "./observe-loader.ts";
import {
  requestFieldPromises,
  requestKeysBySegment,
  runRequestLoaderFields,
} from "./request-loaders.ts";

export type LoaderResult =
  | {
      type: "data";
      /**
       * Synchronous (JSON-serialisable) loader fields. Injected into the initial
       * HTML shell as `__FURIN_DATA__` / the deferred registry's `_data` object.
       */
      syncData: RuntimeData;
      /**
       * Promise-valued fields from a `defer()` return. `undefined` when the page
       * loader did not call `defer()`. Streamed as late `<script>` resolution
       * chunks (SSR) or as NDJSON chunks via `?_furin=data` (SPA nav).
       */
      deferredPromises: Record<string, Promise<unknown>> | undefined;
      headers: Record<string, string>;
    }
  | { type: "redirect"; response: Response }
  | {
      type: "not-found";
      error: FurinNotFoundError;
      headers: Record<string, string>;
      syncData: { [key: string]: unknown };
      deferredPromises?: { [key: string]: Promise<unknown> };
    }
  | {
      type: "error";
      /**
       * Original thrown value, kept for digest computation and server logging.
       * For thrown `Response` objects this is the Response instance whose body
       * has already been consumed by `runLoaders` (do NOT read it again).
       */
      error: unknown;
      /** HTTP status to return. Default 500; sourced from thrown Responses and Eden problems. */
      status: number;
      /**
       * Safe public message extracted at the loader boundary. For thrown
       * `Response` objects: response body or `statusText`. For thrown `Error`
       * values carrying an Eden problem: its detail or title. For other
       * `Error` / non-Error values: a generic "Something went wrong" string (the raw
       * error/message is never leaked here — `errorMessageOf` decides what to
       * surface from the original `error` value when an `error.tsx` fallback
       * exists).
       */
      message: string;
      headers: Record<string, string>;
      syncData: { [key: string]: unknown };
      deferredPromises?: { [key: string]: Promise<unknown> };
    };

/**
 * Wraps the Elysia context so that any property NOT present on `ctx` is
 * returned as an individual `Promise<value>` resolved from the accumulated
 * parent data. Inherited request fields use their own promises, independent
 * of public parent loaders. Properties that ARE present on `ctx` (request,
 * params, set, …) are returned as-is.
 *
 * A per-prop cache ensures the same Promise instance is returned on repeated
 * access of the same field (stable reference for Promise.all etc.).
 */
function createLoaderCtx(
  ctx: RuntimeData,
  accumulatedParentPromise: Promise<RuntimeData>,
  inheritedRequestFields: Record<string, Promise<unknown>> | undefined,
  onParentFieldAccess?: (key: string) => void
): RuntimeData {
  const cache = new Map<string, Promise<unknown>>();
  return new Proxy(ctx, {
    get(target, prop: string | symbol) {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop);
      }
      // Short-circuit well-known Promise/serialisation introspection keys so
      // the proxy is never treated as a thenable by Promise.resolve() or
      // JSON.stringify(), which would cause silent infinite loops or wrong types.
      if (prop === "then" || prop === "catch" || prop === "finally" || prop === "toJSON") {
        return Reflect.get(target, prop);
      }
      // Kiana keeps status/problem/redirect/defer and decorators on the
      // Elysia context prototype. Preserve those while excluding generic
      // Object.prototype keys that may legitimately be parent loader data.
      if (
        Object.hasOwn(target, prop) ||
        (prop in target && !Object.hasOwn(Object.prototype, prop))
      ) {
        return target[prop];
      }
      if (inheritedRequestFields && Object.hasOwn(inheritedRequestFields, prop)) {
        return inheritedRequestFields[prop];
      }
      // Everything else is a parent-data field → individual lazy Promise.
      onParentFieldAccess?.(prop);
      let entry = cache.get(prop);
      if (!entry) {
        entry = accumulatedParentPromise.then((data) => data[prop]);
        cache.set(prop, entry);
      }
      return entry;
    },
  });
}

function startSegmentLoader(
  route: ResolvedRoute,
  ctx: Context,
  segment: RuntimeRoute | RuntimePage,
  index: number,
  label: string,
  parent: Promise<RuntimeData>,
  publicParent: Promise<RuntimeData>,
  inheritedRequestFields: Record<string, Promise<unknown>> | undefined,
  ctxRecord: RuntimeData,
  publicCtxRecord: RuntimeData,
  mixed: boolean
): Promise<RuntimeData> {
  const publicSegment = mixed && (segment.mode ?? route.mode) !== "ssr";
  const parentFieldsRead = new Set<string>();
  const loaderCtx = createLoaderCtx(
    publicSegment ? publicCtxRecord : ctxRecord,
    publicSegment ? publicParent : parent,
    publicSegment ? undefined : inheritedRequestFields,
    publicSegment ? (key) => parentFieldsRead.add(key) : undefined
  );
  return observeLoader(
    () => {
      const run = async () => (await segment.loader?.(loaderCtx)) ?? {};
      return publicSegment
        ? cacheMixedPublicLoader(route, ctx, segment, index, publicParent, parentFieldsRead, run)
        : run();
    },
    label,
    ctx.path
  );
}

async function recoverLoaderError(
  route: ResolvedRoute,
  ctx: Context,
  error: unknown,
  loaderMap: Map<RuntimeRoute, Promise<RuntimeData>>,
  requestFields: ReturnType<typeof runRequestLoaderFields>
): Promise<Exclude<LoaderResult, { type: "data" }>> {
  let failure = error;
  const segments: SegmentData[] = [];
  for (const [index, segment] of route.routeChain.entries()) {
    if (
      (segment.loader && !loaderMap.has(segment)) ||
      (segment.requestLoader && !requestFields?.resultsByLoader[index])
    ) {
      break;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: recover already-started ancestors in route order, stopping at the first failure.
      const [publicData, requestData] = await Promise.all([
        loaderMap.get(segment),
        requestFields?.resultsByLoader[index],
      ]);
      const own = splitOneLoaderResult(publicData ?? {});
      if (requestData) {
        const fields = Object.fromEntries(
          Object.entries(requestData).map(([key, value]) => [key, Promise.resolve(value)])
        );
        Object.assign(own.deferred, requestFieldPromises(route, fields, own.sync, own.deferred));
      }
      segments.push(own);
    } catch (parentError) {
      failure = parentError;
      break;
    }
  }
  // Only the segments before the failure keep data; the renderer appends the
  // failed segment's match.
  const { allSync, allDeferred, matches } = flattenSegments(segments, undefined);
  const syncData = {
    ...allSync,
    [ROUTE_MATCHES_KEY]: matches,
    params: ctx.params,
    path: ctx.path,
    query: ctx.query,
  };
  const headers: Record<string, string> = {};
  Object.assign(headers, ctx.set.headers);
  return normalizeLoaderError(
    failure,
    headers,
    syncData,
    Object.keys(allDeferred).length > 0 ? allDeferred : undefined
  );
}

async function runLoadersInternal(
  route: ResolvedRoute,
  ctx: Context,
  includeRequestData: boolean,
  mixed: boolean
): Promise<LoaderResult> {
  const loaderMap = new Map<RuntimeRoute, Promise<RuntimeData>>();
  let requestFields: ReturnType<typeof runRequestLoaderFields>;
  try {
    requestFields = includeRequestData ? runRequestLoaderFields(route, ctx) : undefined;
    // Inject `log` so loaders can destructure it directly as `({ log })`.
    // getLogger() resolves the correct logger for every rendering context:
    // live request → evlog request-scoped logger, synthetic render → detached
    // createLogger() from runInSyntheticRenderScope, outside any context → no-op.
    const ctxRecord = includeRequestData
      ? Object.assign(Object.create(Object.getPrototypeOf(ctx)), ctx, { log: getLogger() })
      : createPublicLoaderContext(ctx);
    // Cached public segments see only the query their cache key carries.
    const publicCtxRecord = mixed
      ? createPublicLoaderContext(canonicalCacheRequest(route, ctx.path, ctx).ctx)
      : ctxRecord;

    // All loaders in the chain start immediately. Each receives a Proxy where
    // parent-data fields are individually-awaitable Promises. The loader opts
    // in to waiting by doing `await user` (or `Promise.all([user, org])`);
    // if it never awaits a parent field it runs in full parallel.
    let accumulatedParentPromise: Promise<RuntimeData> = Promise.resolve({});
    let publicParentPromise: Promise<RuntimeData> = Promise.resolve({});

    let loaderIndex = 0;
    for (const [routeIndex, r] of route.routeChain.entries()) {
      const parentAccum = accumulatedParentPromise; // capture for closure
      const publicParent = publicParentPromise;
      const privateSegment = mixed && (r.mode ?? route.mode) === "ssr";

      if (r.loader) {
        const index = loaderIndex;
        const loaderPromise = startSegmentLoader(
          route,
          ctx,
          r,
          index,
          `layout:${loaderIndex}`,
          parentAccum,
          publicParent,
          requestFields?.fieldsByLoader[routeIndex - 1],
          ctxRecord,
          publicCtxRecord,
          mixed
        );
        loaderIndex += 1;
        loaderMap.set(r, loaderPromise);

        // Accumulate: previous ancestors + this loader's result.
        // A void .catch() suppresses the "unhandled rejection" warning that
        // fires when a sibling or child loader throws — but unlike `.catch(
        // () => ({}))` it does NOT resolve the promise, so child loaders'
        // field-accesses via createLoaderCtx still receive the rejection
        // instead of silently resolving to undefined. The real rejection is
        // re-thrown by the Promise.all below.
        accumulatedParentPromise = Promise.all([parentAccum, loaderPromise]).then(([acc, own]) =>
          mergeParentData(acc, own, ctx.path)
        );
        accumulatedParentPromise.catch(() => {
          /* suppress unhandled-rejection warning */
        });
        if (mixed && !privateSegment) {
          publicParentPromise = Promise.all([publicParent, loaderPromise]).then(([acc, own]) => ({
            ...acc,
            ...own,
          }));
          publicParentPromise.catch(() => {
            /* suppress unhandled-rejection warning */
          });
        }
      }
    }

    // Page loader receives all route-chain fields as individual Promises.
    const pagePromise: Promise<RuntimeData> = route.page.loader
      ? startSegmentLoader(
          route,
          ctx,
          route.page,
          route.routeChain.length,
          "page",
          accumulatedParentPromise,
          publicParentPromise,
          requestFields?.fields,
          ctxRecord,
          publicCtxRecord,
          mixed
        )
      : Promise.resolve({});

    // Await everything in parallel. Segments are ordered root → … → page so
    // later loaders (page last) overwrite earlier ones on key collision.
    const [pageResult, ...chainResults] = await Promise.all([
      pagePromise,
      ...route.routeChain.map((entry) => loaderMap.get(entry)),
    ]);
    await requestFields?.noFieldCompletion;
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);

    // Any loader wrapped with `defer()` (page OR route/layout) contributes its
    // Promise-valued fields to `allDeferred` and its scalars to `allSync`.
    // Non-deferred loaders keep everything in `allSync` — even Promise values,
    // since only an explicit `defer()` opts into streaming.
    const { allSync, allDeferred, matches } = flattenSegments(
      [
        ...chainResults.map((result) =>
          result === undefined ? NO_SEGMENT_DATA : splitOneLoaderResult(result)
        ),
        splitOneLoaderResult(pageResult),
      ],
      requestKeysBySegment(route)
    );
    if (requestFields !== undefined) {
      Object.assign(
        allDeferred,
        requestFieldPromises(route, requestFields.fields, allSync, allDeferred)
      );
    }

    // Route context is always injected into syncData so components receive
    // params, query and path regardless of the serialisation path (SSR, SPA
    // nav, dev cache).
    allSync.params = ctx.params;
    allSync.path = ctx.path;
    allSync.query = ctx.query;
    allSync[ROUTE_MATCHES_KEY] = matches;
    return {
      deferredPromises: Object.keys(allDeferred).length > 0 ? allDeferred : undefined,
      headers,
      syncData: allSync,
      type: "data",
    };
  } catch (err) {
    if (err instanceof Response && isHttpRedirect(err)) {
      return { response: err, type: "redirect" };
    }
    return recoverLoaderError(route, ctx, err, loaderMap, requestFields);
  }
}

function createPublicLoaderContext(ctx: Context): { [key: string]: unknown } {
  const publicContext = {} as { [key: string]: unknown };
  const fail = (): never => {
    throw new Error(
      "[furin] Cached public loaders cannot access request, cookie, headers, or set. Move request-specific work to requestLoader."
    );
  };
  Object.defineProperties(publicContext, {
    cookie: { enumerable: true, get: fail },
    headers: { enumerable: true, get: fail },
    log: { enumerable: true, value: getLogger() },
    params: { enumerable: true, value: ctx.params },
    path: { enumerable: true, value: ctx.path },
    query: { enumerable: true, value: ctx.query },
    redirect: { enumerable: true, value: ctx.redirect },
    request: { enumerable: true, get: fail },
    set: { enumerable: true, get: fail },
  });
  return publicContext;
}

export function runLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  return captureQueryReads(ctx, () => runLoadersInternal(route, ctx, true, false));
}

export function runPublicLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  return captureQueryReads(ctx, () => runLoadersInternal(route, ctx, false, false));
}

export function hasSsrLoaderAncestor(route: ResolvedRoute): boolean {
  return route.routeChain.some((entry) => entry.mode === "ssr" && entry.loader !== undefined);
}

export function hasMixedLoaderModes(route: ResolvedRoute): boolean {
  const pageRevalidate =
    route.mode === "isr" ? (resolveRouteRevalidate(route.page) ?? 60) : undefined;
  return route.routeChain.some(
    (entry) =>
      entry.loader !== undefined &&
      entry.mode !== undefined &&
      (entry.mode !== route.mode ||
        (entry.mode === "isr" && (entry.revalidate ?? 60) !== pageRevalidate))
  );
}

export function runMixedLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  return captureQueryReads(ctx, () => runLoadersInternal(route, ctx, true, true));
}

export function runRouteLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  return hasMixedLoaderModes(route) ? runMixedLoaders(route, ctx) : runLoaders(route, ctx);
}

export function runSegmentPublicLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  return captureQueryReads(ctx, () => runLoadersInternal(route, ctx, false, true));
}
