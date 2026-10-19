import type { RuntimeData } from "../../client/internal/runtime-types.ts";
import { isFurinRscRenderError } from "../../rsc/render-error.ts";
import { computeErrorDigest } from "../../shared/digest.ts";
import { isNotFoundError } from "../../shared/not-found.ts";
import { getLogger } from "../context-logger.ts";
import { isDevelopment } from "../instance.ts";
import type { LoaderResult } from "./loaders.ts";

/**
 * Navigation redirect status codes — the exact set `ctx.redirect()` can emit.
 * Other 3xx codes (304 Not Modified, 305/306) are NOT navigation redirects and
 * must not be treated as one even when they carry a `Location` header.
 */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * `true` only for HTTP responses that are syntactically valid redirects:
 * a navigation redirect status code AND a `Location` header. A redirect status
 * without `Location` is invalid HTTP and almost always a developer mistake —
 * surfaced as an error so it's debuggable rather than silently redirecting to `/`.
 */
export function isHttpRedirect(res: Response): boolean {
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
 * Normalises an error thrown inside a deferred Promise into a value that is
 * safe to send through `toCrossJSON` and that preserves the original semantics
 * after `fromCrossJSON` on the client.
 *
 * Symmetric to the rejection handling in `runLoaders` (a redirect `Response`
 * becomes a redirect result, anything else a failed route match via
 * `recoverLoaderError`) but for the *deferred* path, where the rejection is delivered to a client-side
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
  const development = isDevelopment();
  if (err instanceof Error) {
    if (development) {
      return err;
    }
    const wrapped = sanitizedDeferredError();
    Object.assign(wrapped, { __furinDigest: computeErrorDigest(err) });
    return wrapped;
  }
  if (development) {
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

export async function normalizeLoaderError(
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
      message: isDevelopment() ? err.message : "Something went wrong",
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
