import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestLogger } from "evlog";
// biome-ignore lint/style/noExportedImports: used locally and re-exported for consumers
import { createLogger } from "evlog";
import { createMiddlewareLogger } from "evlog/toolkit";
import { physicalPath } from "../shared/prefix.ts";
import { getFurinEvlogOptions, getRequestLogger, registerEmission } from "./evlog.ts";
import { currentInstance } from "./instance.ts";

export { createLogger };

/**
 * Fallback used when getLogger() is called completely outside any context
 * (not in a live request, not in a synthetic render scope).
 */
const noopLogger: RequestLogger = {
  emit: () => null,
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  error: () => {},
  fork: (_label, fn) => fn() as undefined,
  getContext: () => ({}),
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  info: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  set: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  setLevel: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  warn: () => {},
};

const syntheticRenderStorage = new AsyncLocalStorage<RequestLogger>();

/**
 * Returns the current request-scoped logger.
 *
 * Priority:
 * 1. Live Elysia request handled by the evlog() plugin → full request-scoped wide event
 * 2. Synthetic render scope (ISR revalidation, SSG pre-render) → detached createLogger()
 *    that still drains to the configured adapter (Datadog, Axiom, etc.)
 * 3. Completely outside any context → no-op
 *
 * Import from `@teyik0/furin` instead of `evlog/elysia` so this fallback chain
 * applies in all rendering contexts.
 */
export function getLogger(): RequestLogger {
  try {
    return getRequestLogger();
  } catch {
    return syntheticRenderStorage.getStore() ?? noopLogger;
  }
}

/**
 * Runs `fn` inside a synthetic render scope.
 *
 * Creates a detached `createLogger()` instance for the duration of `fn`.
 * `getLogger()` calls inside `fn` (including user loaders) return this logger
 * instead of throwing. On completion, the accumulated wide event is emitted to
 * the global drain with the provided initial context (e.g. route pattern).
 *
 * Used by renderForPath() which drives both ISR background revalidation and
 * SSG pre-renders — neither has a live Elysia request context.
 */
export async function runInSyntheticRenderScope<T>(
  fn: () => Promise<T> | T,
  initialContext: Record<string, unknown>
): Promise<T> {
  const options = getFurinEvlogOptions();
  const route = typeof initialContext.route === "string" ? initialContext.route : "/";
  const middleware =
    options === undefined
      ? undefined
      : createMiddlewareLogger({
          ...options,
          waitUntil: undefined,
          method: "GET",
          path: physicalPath(currentInstance().prefix, route),
        });
  const logger = middleware?.logger ?? createLogger(initialContext);
  if (middleware) {
    logger.set(initialContext);
  }
  try {
    return await syntheticRenderStorage.run(logger, () => Promise.resolve(fn()));
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    const emission = Promise.resolve()
      .then(() => (middleware ? middleware.finish() : logger.emit()))
      .then(
        () => undefined,
        (error: unknown) => {
          console.error("[furin] Synthetic log emission failed", error);
        }
      );
    registerEmission(emission, options);
  }
}
