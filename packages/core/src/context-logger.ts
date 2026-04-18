import { AsyncLocalStorage } from "node:async_hooks";
import type { RequestLogger } from "evlog";
import { createLogger } from "evlog";
import { useLogger as _evlogUseLogger } from "evlog/elysia";

/**
 * Fallback used when useLogger() is called completely outside any context
 * (not in a live request, not in a synthetic render scope).
 */
const noopLogger: RequestLogger = {
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  set: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  error: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  info: () => {},
  // biome-ignore lint/suspicious/noEmptyBlockStatements: intentional no-op
  warn: () => {},
  emit: () => null,
  getContext: () => ({}),
  fork: (_label, fn) => fn() as undefined,
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
export function useLogger(): RequestLogger {
  try {
    return _evlogUseLogger();
  } catch {
    return syntheticRenderStorage.getStore() ?? noopLogger;
  }
}

/**
 * Runs `fn` inside a synthetic render scope.
 *
 * Creates a detached `createLogger()` instance for the duration of `fn`.
 * `useLogger()` calls inside `fn` (including user loaders) return this logger
 * instead of throwing. On completion, the accumulated wide event is emitted to
 * the global drain with the provided initial context (e.g. route pattern).
 *
 * Used by renderForPath() which drives both ISR background revalidation and
 * SSG pre-renders — neither has a live Elysia request context.
 */
export async function runInSyntheticRenderScope<T>(
  fn: () => Promise<T> | T,
  initialContext: Record<string, unknown> = {}
): Promise<T> {
  const logger = createLogger(initialContext);
  try {
    const result = await syntheticRenderStorage.run(logger, () => Promise.resolve(fn()));
    logger.emit();
    return result;
  } catch (err) {
    logger.error(err instanceof Error ? err : new Error(String(err)));
    logger.emit();
    throw err;
  }
}
