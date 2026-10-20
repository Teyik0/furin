import { initLogger, type LoggerConfig } from "evlog";

const FURIN_LOGGER_SAMPLING = Symbol.for("@teyik0/furin/logger-sampling");

function loggerState(): typeof globalThis & { [key: symbol]: string | undefined } {
  return globalThis as typeof globalThis & { [key: symbol]: string | undefined };
}

/**
 * evlog's logger, and with it head sampling, is process-wide. The first
 * `furin()` initializes it; a later instance may omit `sampling` (it inherits
 * the active one) but must not configure a different one that would be
 * silently ignored.
 */
export function initializeFurinLogger(config: LoggerConfig): void {
  const state = loggerState();
  const sampling = JSON.stringify(config.sampling ?? null);
  const active = state[FURIN_LOGGER_SAMPLING];
  if (active === undefined) {
    initLogger(config);
    state[FURIN_LOGGER_SAMPLING] = sampling;
    return;
  }
  if (config.sampling !== undefined && sampling !== active) {
    throw new Error(
      `[furin] logger.sampling is process-wide (evlog initLogger): this process already samples with ${active}, so ${sampling} would be ignored. Pass the same sampling to every furin() instance, or omit it on later ones.`
    );
  }
}

/** @internal */
export function resetFurinLoggerForTests(): void {
  delete loggerState()[FURIN_LOGGER_SAMPLING];
}
