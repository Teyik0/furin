import { AsyncLocalStorage } from "node:async_hooks";
import { Elysia } from "elysia";
import type { RequestLogger } from "evlog";
import {
  type BaseEvlogOptions,
  createLoggerStorage,
  defineFrameworkIntegration,
  shouldDeferEmitForResponse,
} from "evlog/toolkit";
import {
  currentInstance,
  type FurinInstance,
  instanceSlot,
  requestLogRuntime,
} from "./instance.ts";

interface EvlogRequestContext {
  request: Request;
}

type RequestLogHandle = ReturnType<typeof integration.start>;

interface RequestLogSlot {
  handle: RequestLogHandle | undefined;
  options: FurinEvlogOptions | undefined;
}

const loggerStorage = createLoggerStorage(
  "Furin request context. Make sure the Furin plugin is registered before your routes.",
  "@teyik0/furin:evlog"
);

/** Opened by the wrap before routing; filled once the owning runtime is known. */
const requestLogSlots = new AsyncLocalStorage<RequestLogSlot>();

const integration = defineFrameworkIntegration<EvlogRequestContext>({
  attachLogger: () => undefined,
  extractRequest: ({ request }) => {
    const url = new URL(request.url);
    return {
      headers: request.headers,
      method: request.method,
      path: url.pathname,
      requestId: request.headers.get("x-request-id") ?? undefined,
    };
  },
  name: "furin",
  storage: loggerStorage.storage,
});

export type FurinEvlogOptions = BaseEvlogOptions;
const instanceOptions = instanceSlot<{ options: FurinEvlogOptions | undefined }>(() => ({
  options: undefined,
}));

export function setFurinEvlogOptions(instance: FurinInstance, options: FurinEvlogOptions): void {
  instanceOptions(instance).options = options;
}

export function getFurinEvlogOptions(): FurinEvlogOptions | undefined {
  return instanceOptions(currentInstance()).options;
}

/** The request logger, or the child logger inside `log.fork()`. */
export function getRequestLogger(): RequestLogger {
  const logger = loggerStorage.storage.getStore() ?? requestLogSlots.getStore()?.handle?.logger;
  return logger ?? loggerStorage.useLogger();
}

const runtimeWaitUntil = new Set<NonNullable<FurinEvlogOptions["waitUntil"]>>();

export function setRuntimeEvlogWaitUntil(
  waitUntil: NonNullable<FurinEvlogOptions["waitUntil"]>
): () => void {
  runtimeWaitUntil.add(waitUntil);
  return () => runtimeWaitUntil.delete(waitUntil);
}

export function registerEmission(
  emission: Promise<void>,
  options: FurinEvlogOptions | undefined
): void {
  if (options?.waitUntil) {
    options.waitUntil(emission);
  } else {
    for (const waitUntil of runtimeWaitUntil) {
      waitUntil(emission);
    }
  }
}

async function finishRequestLog(
  handle: RequestLogHandle,
  options: FurinEvlogOptions | undefined,
  response: Response | undefined
): Promise<Response> {
  if (response === undefined) {
    await handle.finish({ status: 101 });
    // Bun represents a successful WebSocket upgrade with `undefined`,
    // while Elysia's beta wrap type still declares Response only.
    return undefined as unknown as Response;
  }
  if (shouldDeferEmitForResponse(response)) {
    return await handle.finishResponse(response);
  }
  // Elysia 2 runs afterResponse/defer before fetch resolves, so emit
  // non-streaming events in the next task instead of delaying the response.
  const { status } = response;
  const emission = new Promise<void>((resolve) => {
    setTimeout(() => {
      handle.finish({ status }).then(
        () => resolve(),
        (error: unknown) => {
          console.error("[furin] Request log emission failed", error);
          resolve();
        }
      );
    }, 0);
  });
  // Register before the platform request context closes, even though the
  // emission itself starts after this response is returned.
  registerEmission(emission, options);
  return response;
}

/**
 * Elysia 2-native evlog integration built on evlog's public adapter toolkit.
 * The wrap opens a slot before routing; `onRequest` starts the logger once
 * every Furin wrap has claimed the request, so the owning runtime's options
 * (exclusions, drain, enrichers) apply regardless of plugin mount order.
 */
export function createFurinEvlog(options: FurinEvlogOptions) {
  return new Elysia({ name: "furin-evlog" })
    .wrap((fetch) => async (request, ...rest) => {
      const slot: RequestLogSlot = { handle: undefined, options: undefined };
      try {
        const response = await requestLogSlots.run(slot, () => fetch(request, ...rest));
        return slot.handle ? await finishRequestLog(slot.handle, slot.options, response) : response;
      } catch (error) {
        await slot.handle?.finish({
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      }
    })
    .onRequest(({ request }) => {
      const slot = requestLogSlots.getStore();
      if (slot === undefined || slot.handle !== undefined) {
        return;
      }
      const runtime = requestLogRuntime();
      slot.options = (runtime && instanceOptions(runtime).options) ?? options;
      slot.handle = integration.start({ request }, slot.options);
    })
    .derive("global", () => ({ log: getRequestLogger() }));
}
