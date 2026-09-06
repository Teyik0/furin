import type { Context } from "elysia";
import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";
import { isDeferred } from "../../client.ts";
import type { RequestLoaderContext } from "../../define-route.ts";
import { isFurinRscRenderError } from "../../rsc/render-error.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { type FurinNotFoundError, isNotFoundError } from "../../shared/not-found.ts";
import { useLogger } from "../context-logger.ts";
import { currentInstrumentationRequest, emitLoaderFinished } from "../devtools/instrumentation.ts";
import type { ResolvedRoute } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";

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
       * chunks (SSR) or as NDJSON chunks via `/_furin/data` (SPA nav).
       */
      deferredPromises: Record<string, Promise<unknown>> | undefined;
      headers: Record<string, string>;
    }
  | { type: "redirect"; response: Response }
  | { type: "not-found"; error: FurinNotFoundError; headers: Record<string, string> }
  | {
      type: "error";
      /**
       * Original thrown value, kept for digest computation and server logging.
       * For thrown `Response` objects this is the Response instance whose body
       * has already been consumed by `runLoaders` (do NOT read it again).
       */
      error: unknown;
      /** HTTP status to return. Default 500; sourced from `Response.status` for thrown Response objects. */
      status: number;
      /**
       * Safe public message extracted at the loader boundary. For thrown
       * `Response` objects: response body or `statusText`. For thrown `Error`
       * / non-Error values: a generic "Something went wrong" string (the raw
       * error/message is never leaked here — `errorMessageOf` decides what to
       * surface from the original `error` value when an `error.tsx` fallback
       * exists).
       */
      message: string;
      headers: Record<string, string>;
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
const ROUTE_CTX_RESERVED_KEYS = new Set(["params", "query", "path"]);

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
 * parent data. Properties that ARE present on `ctx` (request, params, set, …)
 * are returned as-is.
 *
 * A per-prop cache ensures the same Promise instance is returned on repeated
 * access of the same field (stable reference for Promise.all etc.).
 */
function createLoaderCtx(
  ctx: Record<string, unknown>,
  accumulatedParentPromise: Promise<Record<string, unknown>>
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
      // RouteContext fields (request, params, query, set, headers, cookie,
      // path, redirect) are present on target — return directly.
      // Use hasOwn so prototype keys (toString, constructor, …) are not
      // mistaken for context fields and incorrectly hide parent loader data.
      if (Object.hasOwn(target, prop)) {
        return target[prop];
      }
      // Everything else is a parent-data field → individual lazy Promise.
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
        return ctx.cookie[name]?.value;
      },
    }),
    headers: Object.freeze({
      entries: () => headers.entries(),
      get: (name: string) => headers.get(name),
      has: (name: string) => headers.has(name),
    }),
    log: useLogger(),
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

export function runRequestLoaderData(
  route: ResolvedRoute,
  ctx: Context
): Promise<object> | undefined {
  const loaders = route.routeChain
    .map((entry) => entry.requestLoader)
    .filter((loader) => loader !== undefined);
  if (loaders.length === 0) {
    return;
  }
  const requestContext = createRequestLoaderContext(ctx);
  const requestData = Promise.all(
    loaders.map((loader, index) =>
      observeLoader(
        () => Promise.resolve().then(() => loader(requestContext)),
        `request:${index}`,
        ctx.path
      )
    )
  ).then((results) => Object.assign({}, ...results));
  requestData.catch(() => {
    /* React observes the original rejection through requestData. */
  });
  return requestData;
}

export function withRequestLoaderData(
  route: ResolvedRoute,
  ctx: Context,
  publicResult: Extract<LoaderResult, { type: "data" }>
): Extract<LoaderResult, { type: "data" }> {
  const requestData = runRequestLoaderData(route, ctx);
  if (requestData === undefined) {
    throw new Error(
      "[furin] internal invariant: requestLoader data requested for a route without requestLoader"
    );
  }
  return {
    ...publicResult,
    deferredPromises: {
      ...(publicResult.deferredPromises ?? {}),
      requestData,
    },
  };
}

/**
 * Merges per-loader results into the unified sync / deferred maps used by
 * `runLoaders`. `results` is ordered ancestor-most → page, so later loaders
 * overwrite earlier ones on key collision.
 *
 * Cross-map cleanup: when a later loader contributes a key, drop any stale
 * entry from the opposite map. Without this, a key that switches between sync
 * and deferred across loaders would leave both maps populated, and the wire
 * would carry two contradictory values for the same field.
 */
function mergeLoaderResults(results: unknown[]): {
  allSync: Record<string, unknown>;
  allDeferred: Record<string, Promise<unknown>>;
} {
  const allSync: Record<string, unknown> = {};
  const allDeferred: Record<string, Promise<unknown>> = {};
  for (const result of results) {
    const { sync, deferred } = splitOneLoaderResult(result as Record<string, unknown>);
    for (const k of Object.keys(sync)) {
      delete allDeferred[k];
    }
    for (const k of Object.keys(deferred)) {
      delete allSync[k];
    }
    Object.assign(allSync, sync);
    Object.assign(allDeferred, deferred);
  }
  return { allDeferred, allSync };
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
  headers: Record<string, string>
): Promise<Exclude<LoaderResult, { type: "data" }>> {
  if (isNotFoundError(err)) {
    return { error: err, headers, type: "not-found" };
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
    return { error: err, headers, message, status, type: "error" };
  }
  if (isFurinRscRenderError(err)) {
    useLogger().error(err);
    return {
      error: err,
      headers,
      message: IS_DEV ? err.message : "Something went wrong",
      status: 500,
      type: "error",
    };
  }
  return {
    error: err,
    headers,
    message: "Something went wrong",
    status: 500,
    type: "error",
  };
}

async function runLoadersInternal(
  route: ResolvedRoute,
  ctx: Context,
  includeRequestData: boolean
): Promise<LoaderResult> {
  try {
    const requestData = includeRequestData ? runRequestLoaderData(route, ctx) : undefined;
    // Inject `log` so loaders can destructure it directly as `({ log })`.
    // useLogger() resolves the correct logger for every rendering context:
    // live request → evlog request-scoped logger, synthetic render → detached
    // createLogger() from runInSyntheticRenderScope, outside any context → no-op.
    const ctxRecord = includeRequestData
      ? { ...(ctx as Record<string, unknown>), log: useLogger() }
      : createPublicLoaderContext(ctx);
    const loaderMap = new Map<RuntimeRoute, Promise<Record<string, unknown>>>();

    // All loaders in the chain start immediately. Each receives a Proxy where
    // parent-data fields are individually-awaitable Promises. The loader opts
    // in to waiting by doing `await user` (or `Promise.all([user, org])`);
    // if it never awaits a parent field it runs in full parallel.
    let accumulatedParentPromise: Promise<Record<string, unknown>> = Promise.resolve({});

    let loaderIndex = 0;
    for (const r of route.routeChain) {
      const parentAccum = accumulatedParentPromise; // capture for closure

      if (r.loader) {
        const loaderCtx = createLoaderCtx(ctxRecord, parentAccum);
        const loaderPromise = observeLoader(
          async () => (await r.loader?.(loaderCtx)) ?? {},
          `layout:${loaderIndex}`,
          ctx.path
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
        accumulatedParentPromise = Promise.all([parentAccum, loaderPromise]).then(([acc, own]) => {
          if (IS_DEV) {
            // Flattened parent data means a deeper loader silently shadows an
            // ancestor's field (deepest wins). Surface the collision instead.
            for (const key of Object.keys(own)) {
              if (Object.hasOwn(acc, key)) {
                useLogger().warn(
                  `[furin] Loader data collision on "${key}" for ${ctx.path}: a deeper loader overwrites the value inherited from its layout chain (deepest wins).`
                );
              }
            }
          }
          return {
            ...acc,
            ...own,
          };
        });
        accumulatedParentPromise.catch(() => {
          /* suppress unhandled-rejection warning */
        });
      }
    }

    // Page loader receives all route-chain fields as individual Promises.
    const pageCtx = createLoaderCtx(ctxRecord, accumulatedParentPromise);
    const pagePromise: Promise<Record<string, unknown>> = route.page.loader
      ? observeLoader(async () => (await route.page.loader?.(pageCtx)) ?? {}, "page", ctx.path)
      : Promise.resolve({});

    // Await everything in parallel. `results` is ordered layout1 → … → page;
    // the per-loader split preserves that order so later loaders (page last)
    // overwrite earlier ones on key collision — same semantic as the previous
    // non-deferred `Object.assign({}, ...results)` flat merge.
    const results = await Promise.all([...loaderMap.values(), pagePromise]);
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);

    // Any loader wrapped with `defer()` (page OR route/layout) contributes its
    // Promise-valued fields to `allDeferred` and its scalars to `allSync`.
    // Non-deferred loaders keep everything in `allSync` — even Promise values,
    // since only an explicit `defer()` opts into streaming.
    const { allSync, allDeferred } = mergeLoaderResults(results);
    if (requestData !== undefined) {
      allDeferred.requestData = requestData;
    }

    // Route context is always injected into syncData so components receive
    // params, query and path regardless of the serialisation path (SSR, SPA
    // nav, dev cache).
    const routeCtx = { params: ctx.params, path: ctx.path, query: ctx.query };
    return {
      deferredPromises: Object.keys(allDeferred).length > 0 ? allDeferred : undefined,
      headers,
      syncData: { ...allSync, ...routeCtx },
      type: "data",
    };
  } catch (err) {
    const headers: Record<string, string> = {};
    Object.assign(headers, ctx.set.headers);
    return normalizeLoaderError(err, headers);
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
    log: { enumerable: true, value: useLogger() },
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
  return runLoadersInternal(route, ctx, true);
}

export function runPublicLoaders(route: ResolvedRoute, ctx: Context): Promise<LoaderResult> {
  return runLoadersInternal(route, ctx, false);
}

export function hasRequestLoader(route: ResolvedRoute): boolean {
  return route.routeChain.some((entry) => entry.requestLoader !== undefined);
}
