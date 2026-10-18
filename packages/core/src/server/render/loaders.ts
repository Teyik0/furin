import type { Context } from "elysia";
import type {
  RuntimeData,
  RuntimePage,
  RuntimeRoute,
} from "../../client/internal/runtime-types.ts";
import type { RequestLoaderContext } from "../../define-route.ts";
import { isFurinRscRenderError } from "../../rsc/render-error.ts";
import { isDeferred } from "../../shared/defer.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { type FurinNotFoundError, isNotFoundError } from "../../shared/not-found.ts";
import { ROUTE_MATCHES_KEY, type SerializedRouteMatch } from "../../shared/route-matches.ts";
import { canonicalCacheRequest } from "../cache/route-cache.ts";
import { getLogger } from "../context-logger.ts";
import { currentInstrumentationRequest, emitLoaderFinished } from "../devtools/instrumentation.ts";
import { resolveRouteRevalidate } from "../router/patterns.ts";
import type { ResolvedRoute } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import { captureQueryReads } from "../sync/query-context.ts";
import { cacheMixedPublicLoader } from "./mixed-cache.ts";

export type LoaderResult =
  | {
      type: "data";
      /**
       * Synchronous (JSON-serialisable) loader fields. Injected into the initial
       * HTML shell as `__FURIN_DATA__` / the deferred registry's `_data` object.
       */
      syncData: Record<string, unknown>;
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
 * Navigation redirect status codes — the exact set `ctx.redirect()` can emit.
 * Other 3xx codes (304 Not Modified, 305/306) are NOT navigation redirects and
 * must not be treated as one even when they carry a `Location` header.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FURIN_RESERVED_KEY_PREFIX = "__furin";
/**
 * Loader data keys that the render pipeline overwrites with request-context
 * values when assembling component props — a loader field with one of these
 * names is silently dead on arrival.
 */
const ROUTE_CTX_RESERVED_KEYS = new Set([
  "catch",
  "children",
  "finally",
  "key",
  "params",
  "path",
  "query",
  "ref",
  "then",
  "toJSON",
]);

function assertPublicLoaderKey(key: string): void {
  if (key.startsWith(FURIN_RESERVED_KEY_PREFIX)) {
    throw new Error(
      `[furin] Loader data key "${key}" is reserved for framework metadata. Rename this field to avoid conflicts.`
    );
  }
  if (ROUTE_CTX_RESERVED_KEYS.has(key)) {
    throw new Error(
      `[furin] Loader data key "${key}" is reserved: it is overwritten by the route context when component props are assembled. Rename this field to avoid conflicts.`
    );
  }
}

function assertRequestLoaderKey(key: string, ctx: Context): void {
  assertPublicLoaderKey(key);
  if (
    key === "log" ||
    Object.hasOwn(ctx, key) ||
    (key in ctx && !Object.hasOwn(Object.prototype, key))
  ) {
    throw new Error(
      `[furin] requestLoader data key "${key}" is reserved: it is overwritten by the SSR loader context. Rename this field to avoid conflicts.`
    );
  }
}

/**
 * `true` only for HTTP responses that are syntactically valid redirects:
 * a navigation redirect status code AND a `Location` header. A redirect status
 * without `Location` is invalid HTTP and almost always a developer mistake —
 * surfaced as an error so it's debuggable rather than silently redirecting to `/`.
 */
function isHttpRedirect(res: Response): boolean {
  return REDIRECT_STATUSES.has(res.status) && res.headers.has("location");
}

/**
 * Reads the body of a thrown `Response` exactly once. Returns the body text
 * if present, otherwise the response's `statusText`. The body is consumed
 * destructively — callers must NOT read `res.body` / `res.text()` again.
 */
async function readResponseMessage(res: Response): Promise<string> {
  if (res.body === null) {
    return res.statusText;
  }
  try {
    const body = await res.text();
    return body || res.statusText;
  } catch {
    return res.statusText;
  }
}

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
  ctx: Record<string, unknown>,
  accumulatedParentPromise: Promise<Record<string, unknown>>,
  inheritedRequestFields: Record<string, Promise<unknown>> | undefined,
  onParentFieldAccess?: (key: string) => void
): Record<string, unknown> {
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

/**
 * Splits a single loader result into sync scalars and deferred Promises.
 *
 * A loader result is considered "deferred" only when wrapped with `defer()`
 * (i.e. carries the internal deferred brand). A loader that returned a plain
 * object keeps all its values in sync — even if some happen to be Promises —
 * preserving the long-standing semantic that only an explicit `defer()` opts
 * into streaming.
 */
function splitOneLoaderResult(result: Record<string, unknown>): {
  sync: Record<string, unknown>;
  deferred: Record<string, Promise<unknown>>;
} {
  const sync: Record<string, unknown> = {};
  const deferred: Record<string, Promise<unknown>> = {};
  const isDef = isDeferred(result);
  for (const [key, value] of Object.entries(result)) {
    assertPublicLoaderKey(key);
    if (isDef && isPromiseLike(value)) {
      deferred[key] = Promise.resolve(value);
    } else {
      sync[key] = value;
    }
  }
  return { deferred, sync };
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function createRequestLoaderContext(ctx: Context): RequestLoaderContext {
  const headers = new Headers(ctx.request.headers);
  return Object.freeze({
    cookies: Object.freeze({
      get(name: string): unknown {
        const value = ctx.cookie?.[name]?.value;
        if (value !== undefined) {
          return value;
        }
        for (const part of headers.get("cookie")?.split(";") ?? []) {
          const separator = part.indexOf("=");
          if (separator < 0 || part.slice(0, separator).trim() !== name) {
            continue;
          }
          const raw = part.slice(separator + 1).trim();
          const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
          try {
            return decodeURIComponent(unquoted);
          } catch {
            return unquoted;
          }
        }
        return undefined;
      },
    }),
    headers: Object.freeze({
      entries: () => headers.entries(),
      get: (name: string) => headers.get(name),
      has: (name: string) => headers.has(name),
    }),
    log: getLogger(),
    params: ctx.params,
    path: ctx.path,
    query: ctx.query,
    request: ctx.request,
  });
}

function observeLoader<T extends object>(
  run: () => T | Promise<T>,
  loader: string,
  path: string
): Promise<T> {
  const request = currentInstrumentationRequest();
  const startedAt = performance.now();
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(run());
  } catch (error) {
    promise = Promise.reject(error);
  }
  if (!(IS_DEV && request)) {
    return promise;
  }
  return promise.then(
    (value) => {
      emitLoaderFinished({
        durationMs: performance.now() - startedAt,
        fieldNames: Object.keys(value),
        loader,
        operationId: request.operationId,
        path,
        requestId: request.requestId,
        status: "fulfilled",
      });
      return value;
    },
    (error: unknown) => {
      emitLoaderFinished({
        durationMs: performance.now() - startedAt,
        fieldNames: [],
        loader,
        operationId: request.operationId,
        path,
        requestId: request.requestId,
        status: "rejected",
      });
      throw error;
    }
  );
}

function requestLoaderIndexes(route: ResolvedRoute): number[] {
  return route.routeChain.flatMap((entry, index) => (entry.requestLoader ? [index] : []));
}

/** Request field names declared by each route-chain entry, in chain order. */
function requestKeysBySegment(route: ResolvedRoute): string[][] | undefined {
  const loaderIndexes = requestLoaderIndexes(route);
  if (route.requestKeysByLoader !== undefined || loaderIndexes.length !== 1) {
    return route.requestKeysByLoader;
  }
  return route.routeChain.map((_, index) =>
    index === loaderIndexes[0] ? (route.requestKeys ?? []) : []
  );
}

export function runRequestLoaderFields(
  route: ResolvedRoute,
  ctx: Context
):
  | {
      fields: Record<string, Promise<unknown>>;
      fieldsByLoader: Record<string, Promise<unknown>>[];
      noFieldCompletion: Promise<void>;
      resultsByLoader: (Promise<RuntimeData> | undefined)[];
    }
  | undefined {
  const loaderIndexes = requestLoaderIndexes(route);
  if (loaderIndexes.length === 0) {
    return;
  }
  if (route.requestKeys === undefined) {
    throw new Error(`[furin] Missing requestLoader field metadata for ${route.pattern}.`);
  }
  const declarations = requestKeysBySegment(route);
  if (declarations?.length !== route.routeChain.length) {
    throw new Error(`[furin] Missing per-loader request field metadata for ${route.pattern}.`);
  }
  const declaredKeys = declarations.map((keys) => new Set(keys));
  const requestKeys = new Set(route.requestKeys);
  const requestContext = createRequestLoaderContext(ctx);
  const results = loaderIndexes.map((index) => {
    const loader = route.routeChain[index]?.requestLoader;
    if (!loader) {
      throw new Error(`[furin] Missing requestLoader at route index ${index}.`);
    }
    const invocation = Promise.resolve().then(() => loader(requestContext));
    const result = observeLoader(() => invocation, `request:${index}`, ctx.path).then((value) => {
      const data = value as Record<string, unknown>;
      for (const key of Object.keys(data)) {
        assertRequestLoaderKey(key, ctx);
        if (!declaredKeys[index]?.has(key)) {
          throw new Error(
            `[furin] requestLoader in ${route.pattern} returned undeclared field "${key}".`
          );
        }
      }
      return data;
    });
    result.catch(() => {
      /* A declared field observes the rejection; empty loaders have no field to render. */
    });
    return { index, result };
  });
  let fields: Record<string, Promise<unknown>> = {};
  const fieldsByLoader = route.routeChain.map((_, boundaryIndex) => {
    fields = { ...fields };
    for (const key of declarations[boundaryIndex] ?? []) {
      if (!requestKeys.has(key)) {
        continue;
      }
      const candidates = results.filter(
        ({ index }) => index <= boundaryIndex && declaredKeys[index]?.has(key)
      );
      fields[key] = Promise.all(candidates.map(({ result }) => result)).then((values) => {
        for (let index = values.length - 1; index >= 0; index -= 1) {
          const data = values[index];
          if (data && Object.hasOwn(data, key)) {
            return data[key];
          }
        }
      });
      fields[key].catch(() => {
        /* React or the transport observes the original rejection after public loaders settle. */
      });
    }
    return fields;
  });
  for (const key of route.requestKeys) {
    if (!Object.hasOwn(fields, key)) {
      throw new Error(`[furin] No requestLoader declares field "${key}" in ${route.pattern}.`);
    }
  }
  const noFieldCompletion = Promise.all(
    results.filter(({ index }) => declarations[index]?.length === 0).map(({ result }) => result)
  ).then(() => undefined);
  noFieldCompletion.catch(() => {
    /* The caller observes this after the public loaders settle. */
  });
  const resultsByLoader = route.routeChain.map(
    (_, index) => results.find((entry) => entry.index === index)?.result
  );
  return { fields, fieldsByLoader, noFieldCompletion, resultsByLoader };
}

function requestFieldPromises(
  route: ResolvedRoute,
  fields: Record<string, Promise<unknown>>,
  syncData: Record<string, unknown>,
  publicDeferred: Record<string, Promise<unknown>> | undefined
): Record<string, Promise<unknown>> {
  for (const key of Object.keys(fields)) {
    if (Object.hasOwn(syncData, key) || Object.hasOwn(publicDeferred ?? {}, key)) {
      throw new Error(
        `[furin] requestLoader field "${key}" collides with public loader data in ${route.pattern}.`
      );
    }
  }
  return fields;
}

export function withRequestLoaderData(
  route: ResolvedRoute,
  ctx: Context,
  publicResult: Extract<LoaderResult, { type: "data" }>
): Promise<Extract<LoaderResult, { type: "data" }>> {
  return captureQueryReads(
    ctx,
    async () => {
      const requestFields = runRequestLoaderFields(route, ctx);
      if (requestFields === undefined) {
        throw new Error(
          "[furin] internal invariant: requestLoader data requested for a route without requestLoader"
        );
      }
      await requestFields.noFieldCompletion;
      return {
        ...publicResult,
        deferredPromises: {
          ...(publicResult.deferredPromises ?? {}),
          ...requestFieldPromises(
            route,
            requestFields.fields,
            publicResult.syncData,
            publicResult.deferredPromises
          ),
        },
      };
    },
    "eden-request-queries"
  );
}

interface SegmentData {
  deferred: Record<string, Promise<unknown>>;
  sync: Record<string, unknown>;
}

const NO_SEGMENT_DATA: SegmentData = { deferred: {}, sync: {} };

/**
 * Flattens per-segment loader data (root → page) into the page's sync and
 * deferred maps, where later segments overwrite earlier ones on key collision,
 * and serializes one success match per segment.
 *
 * Cross-map cleanup: when a later segment contributes a key, drop any stale
 * entry from the opposite map so the wire never carries two values for it.
 *
 * A match names the flat key holding each of its fields. When a deeper segment
 * overwrote a field, the segment's own value moves to a `__furinMatch` slot so
 * its layout still receives it. Request fields are referenced by name: their
 * promises are attached (or postponed by PPR) after the public loaders run.
 */
function flattenSegments(
  segments: SegmentData[],
  requestKeys: string[][] | undefined
): {
  allDeferred: Record<string, Promise<unknown>>;
  allSync: Record<string, unknown>;
  matches: SerializedRouteMatch[];
} {
  const allSync: Record<string, unknown> = {};
  const allDeferred: Record<string, Promise<unknown>> = {};
  for (const { sync, deferred } of segments) {
    for (const k of Object.keys(sync)) {
      delete allDeferred[k];
    }
    for (const k of Object.keys(deferred)) {
      delete allSync[k];
    }
    Object.assign(allSync, sync);
    Object.assign(allDeferred, deferred);
  }
  const matches = segments.map(({ sync, deferred }, index): SerializedRouteMatch => {
    const fields: { [field: string]: string } = {};
    for (const [values, flat] of [
      [sync, allSync],
      [deferred, allDeferred],
    ] as const) {
      for (const [field, value] of Object.entries(values)) {
        if (Object.is(flat[field], value)) {
          fields[field] = field;
        } else {
          const slot = `__furinMatch${index}:${field}`;
          (flat as Record<string, unknown>)[slot] = value;
          fields[field] = slot;
        }
      }
    }
    for (const field of requestKeys?.[index] ?? []) {
      fields[field] ??= field;
    }
    return { fields, status: "success" };
  });
  return { allDeferred, allSync, matches };
}

/**
 * Normalises an error thrown inside a deferred Promise into a value that is
 * safe to send through `toCrossJSON` and that preserves the original semantics
 * after `fromCrossJSON` on the client.
 *
 * Symmetric to the rejection handling in `runLoaders` (lines 247-272) but for
 * the *deferred* path, where the rejection is delivered to a client-side
 * `<Await>` instead of becoming a top-level response.
 *
 *  - `notFound()`         → `Error` carrying `__furinBrand` + `data` so the
 *                            client-side `isNotFoundError()` (duck-typed)
 *                            recognises the rejection.
 *  - `Response(status, body)` → `Error` carrying `__furinStatus` and the
 *                            body/statusText as `message`.
 *  - `Error`              → returned unchanged.
 *  - anything else        → wrapped in `new Error(String(value))`.
 */
export async function serializeDeferredRejection(err: unknown): Promise<unknown> {
  if (isNotFoundError(err)) {
    const wrapped = new Error(err.message);
    Object.assign(wrapped, { __furinBrand: "FURIN_NOT_FOUND", data: err.data });
    return wrapped;
  }
  if (err instanceof Response) {
    const body = await readResponseMessage(err);
    const wrapped = new Error(body || err.statusText || "Something went wrong");
    Object.assign(wrapped, { __furinStatus: err.status });
    return wrapped;
  }
  if (err instanceof Error) {
    if (IS_DEV) {
      return err;
    }
    const wrapped = sanitizedDeferredError();
    Object.assign(wrapped, { __furinDigest: computeErrorDigest(err) });
    return wrapped;
  }
  if (IS_DEV) {
    return new Error(String(err));
  }
  const wrapped = sanitizedDeferredError();
  Object.assign(wrapped, { __furinDigest: computeErrorDigest(err) });
  return wrapped;
}

function sanitizedDeferredError(): Error {
  const error = new Error("An unexpected error occurred.");
  for (const property of [
    "column",
    "line",
    "originalColumn",
    "originalLine",
    "sourceURL",
    "stack",
  ]) {
    Reflect.deleteProperty(error, property);
  }
  return error;
}

async function normalizeLoaderError(
  err: unknown,
  headers: Record<string, string>,
  syncData: RuntimeData,
  deferredPromises: { [key: string]: Promise<unknown> } | undefined
): Promise<Exclude<LoaderResult, { type: "data" }>> {
  if (isNotFoundError(err)) {
    return { deferredPromises, error: err, headers, syncData, type: "not-found" };
  }
  if (err instanceof Response) {
    if (isHttpRedirect(err)) {
      return { response: err, type: "redirect" };
    }
    // Non-redirect Response → error. Read the body ONCE here so downstream
    // consumers (digest, logging, error UI) all share the same extracted
    // message without consuming the stream a second time.
    //
    // A *malformed redirect* is a redirect-status code WITHOUT a `Location`
    // header (we only reach here when `isHttpRedirect` was false) — invalid
    // HTTP, coerced to 500. Other 3xx codes (304/305/306) are not redirects
    // at all, so they keep their own status rather than being rewritten.
    const isMalformedRedirect = REDIRECT_STATUSES.has(err.status);
    const status = isMalformedRedirect ? 500 : err.status;
    const body = await readResponseMessage(err);
    const message = body || "Something went wrong";
    return { deferredPromises, error: err, headers, message, status, syncData, type: "error" };
  }
  if (
    err instanceof Error &&
    "status" in err &&
    typeof err.status === "number" &&
    err.status >= 400 &&
    err.status <= 599 &&
    "value" in err &&
    err.value !== null &&
    typeof err.value === "object" &&
    "status" in err.value &&
    err.value.status === err.status &&
    "type" in err.value &&
    typeof err.value.type === "string"
  ) {
    let message = "Something went wrong";
    if ("detail" in err.value && typeof err.value.detail === "string") {
      message = err.value.detail;
    } else if ("title" in err.value && typeof err.value.title === "string") {
      message = err.value.title;
    }
    return {
      deferredPromises,
      error: err,
      headers,
      message,
      status: err.status,
      syncData,
      type: "error",
    };
  }
  if (isFurinRscRenderError(err)) {
    getLogger().error(err);
    return {
      deferredPromises,
      error: err,
      headers,
      message: IS_DEV ? err.message : "Something went wrong",
      status: 500,
      syncData,
      type: "error",
    };
  }
  return {
    deferredPromises,
    error: err,
    headers,
    message: "Something went wrong",
    status: 500,
    syncData,
    type: "error",
  };
}

function mergeParentData(
  parent: Record<string, unknown>,
  own: Record<string, unknown>,
  path: string
): Record<string, unknown> {
  if (IS_DEV) {
    for (const key of Object.keys(own)) {
      if (Object.hasOwn(parent, key)) {
        getLogger().warn(
          `[furin] Loader data collision on "${key}" for ${path}: a deeper loader overwrites the value inherited from its layout chain (deepest wins).`
        );
      }
    }
  }
  return { ...parent, ...own };
}

function startSegmentLoader(
  route: ResolvedRoute,
  ctx: Context,
  segment: RuntimeRoute | RuntimePage,
  index: number,
  label: string,
  parent: Promise<Record<string, unknown>>,
  publicParent: Promise<Record<string, unknown>>,
  inheritedRequestFields: Record<string, Promise<unknown>> | undefined,
  ctxRecord: Record<string, unknown>,
  publicCtxRecord: Record<string, unknown>,
  mixed: boolean
): Promise<Record<string, unknown>> {
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
  const loaderMap = new Map<RuntimeRoute, Promise<Record<string, unknown>>>();
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
    let accumulatedParentPromise: Promise<Record<string, unknown>> = Promise.resolve({});
    let publicParentPromise: Promise<Record<string, unknown>> = Promise.resolve({});

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
    const pagePromise: Promise<Record<string, unknown>> = route.page.loader
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

export function hasRequestLoader(route: ResolvedRoute): boolean {
  return route.routeChain.some((entry) => entry.requestLoader !== undefined);
}
