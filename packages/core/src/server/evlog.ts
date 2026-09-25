import { Elysia } from "elysia";
import type { RequestLogger } from "evlog";
import {
  type BaseEvlogOptions,
  createLoggerStorage,
  defineFrameworkIntegration,
  shouldDeferEmitForResponse,
} from "evlog/toolkit";

interface EvlogRequestContext {
  request: Request;
}

const loggerStorage = createLoggerStorage(
  "Furin request context. Make sure the Furin plugin is registered before your routes.",
  "@teyik0/furin:evlog"
);

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

export const getRequestLogger = loggerStorage.useLogger;

let runtimeWaitUntil: NonNullable<FurinEvlogOptions["waitUntil"]> | undefined;

export function setRuntimeEvlogWaitUntil(
  waitUntil: NonNullable<FurinEvlogOptions["waitUntil"]>
): void {
  runtimeWaitUntil = waitUntil;
}

/** Elysia 2-native evlog integration built on evlog's public adapter toolkit. */
export function createFurinEvlog(options: FurinEvlogOptions) {
  const requestLoggers = new WeakMap<Request, RequestLogger>();

  return new Elysia({ name: "furin-evlog" })
    .derive("global", ({ request }) => {
      const log = requestLoggers.get(request);
      if (log === undefined) {
        throw new Error("[furin] Request logger was not initialized");
      }
      return { log };
    })
    .wrap((fetch) => async (request, ...rest) => {
      const handle = integration.start({ request }, options);
      requestLoggers.set(request, handle.logger);
      try {
        const response = await handle.runWith(() => fetch(request, ...rest));
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
        // Register before the Vercel request context closes, even though the
        // emission itself starts after this response is returned.
        (options.waitUntil ?? runtimeWaitUntil)?.(emission);
        return response;
      } catch (error) {
        await handle.finish({
          error: error instanceof Error ? error : new Error(String(error)),
        });
        throw error;
      } finally {
        requestLoggers.delete(request);
      }
    });
}
