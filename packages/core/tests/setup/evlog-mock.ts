import { mock } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import type { LoggerConfig, RequestLogger } from "evlog";
import type { EvlogElysiaOptions } from "evlog/elysia";
import type { BaseEvlogOptions } from "evlog/toolkit";

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
      evlogErrorMock(error instanceof Error || typeof error === "string" ? error : String(error));
    },
    fork: (_label: string, fn: () => unknown) => fn(),
    getContext: () => ctx,
    info: noop,
    set: (entry: EvlogMockFields) => {
      Object.assign(ctx, entry);
      setHandler(entry);
    },
    setLevel: noop,
    warn: (message: string) => evlogWarnMock(message),
  }),
  initLogger: initLoggerOptionsMock,
  log: { debug: noop, error: noop, info: noop, warn: noop },
  useLogger: createUseLoggerMock,
}));

const requestLoggerStorage = new AsyncLocalStorage<RequestLogger>();

mock.module(join(import.meta.dir, "../../src/server/evlog.ts"), () => ({
  createFurinEvlog: (options: BaseEvlogOptions) => {
    evlogOptionsMock(options);
    const requestLoggers = new WeakMap<Request, RequestLogger>();
    return new Elysia({ name: "furin-evlog-test" })
      .derive("global", ({ request }) => {
        const log = requestLoggers.get(request);
        if (log === undefined) {
          throw new Error("No request logger");
        }
        return { log };
      })
      .wrap((fetch) => async (request, ...rest) => {
        const logger = createUseLoggerMock();
        requestLoggers.set(request, logger);
        try {
          return await requestLoggerStorage.run(logger, () => fetch(request, ...rest));
        } finally {
          requestLoggers.delete(request);
        }
      });
  },
  getRequestLogger: () => {
    const logger = requestLoggerStorage.getStore();
    if (logger === undefined) {
      throw new Error("No request logger");
    }
    return logger;
  },
  setRuntimeEvlogWaitUntil: noop,
}));
