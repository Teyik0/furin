import { initLogger, type LoggerConfig } from "evlog";

const FURIN_LOGGER_INITIALIZED = Symbol.for("@teyik0/furin/logger-initialized");

function loggerState(): typeof globalThis & { [key: symbol]: boolean | undefined } {
  return globalThis as typeof globalThis & { [key: symbol]: boolean | undefined };
}

export function initializeFurinLogger(config: LoggerConfig): void {
  const state = loggerState();
  if (state[FURIN_LOGGER_INITIALIZED]) {
    return;
  }
  initLogger(config);
  state[FURIN_LOGGER_INITIALIZED] = true;
}

/** @internal */
export function resetFurinLoggerForTests(): void {
  delete loggerState()[FURIN_LOGGER_INITIALIZED];
}
