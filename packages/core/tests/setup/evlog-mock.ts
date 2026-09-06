import { mock } from "bun:test";
import type { AnyElysia } from "elysia";
import type { LoggerConfig, RequestLogger } from "evlog";
import type { EvlogElysiaOptions } from "evlog/elysia";

export interface EvlogMockFields {
  [key: string]: unknown;
}

export type EvlogMockSet = (entry: EvlogMockFields) => void;

const noop = () => undefined;

export const evlogSetMock = mock((_entry: EvlogMockFields) => undefined);
export const evlogErrorMock = mock((_error: string | Error) => undefined);
export const evlogWarnMock = mock((_message: string) => undefined);
export const evlogOptionsMock = mock((_options: EvlogElysiaOptions | undefined) => undefined);
export const initLoggerOptionsMock = mock((_options: LoggerConfig) => undefined);

let setHandler: EvlogMockSet = evlogSetMock;

function createUseLoggerMock(): RequestLogger {
  return {
    emit: () => null,
    error: evlogErrorMock,
    fork: (_label: string, fn: () => unknown) => fn(),
    getContext: () => ({}),
    info: noop,
    set: (entry: EvlogMockFields) => setHandler(entry),
    setLevel: noop,
    warn: (message: string) => evlogWarnMock(message),
  };
}

export function setEvlogSetHandler(handler: EvlogMockSet): void {
  setHandler = handler;
}

export function resetEvlogMock(): void {
  setHandler = evlogSetMock;
  evlogErrorMock.mockClear();
  evlogOptionsMock.mockClear();
  evlogSetMock.mockClear();
  evlogWarnMock.mockClear();
  initLoggerOptionsMock.mockClear();
}

mock.module("evlog/elysia", () => ({
  evlog: (options: EvlogElysiaOptions | undefined) => {
    evlogOptionsMock(options);
    return (app: AnyElysia) =>
      app.derive(() => ({
        log: {
          set: (entry: EvlogMockFields) => setHandler(entry),
        },
      }));
  },
  useLogger: createUseLoggerMock,
}));

mock.module("evlog", () => ({
  createLogger: (ctx: EvlogMockFields = {}) => ({
    emit: noop,
    error: (error: unknown) => {
      ctx.error = error;
    },
    fork: (_label: string, fn: () => unknown) => fn(),
    getContext: () => ctx,
    info: noop,
    set: (entry: EvlogMockFields) => {
      Object.assign(ctx, entry);
    },
    setLevel: noop,
    warn: noop,
  }),
  initLogger: initLoggerOptionsMock,
  log: { debug: noop, error: noop, info: noop, warn: noop },
  useLogger: createUseLoggerMock,
}));
