import { AsyncLocalStorage } from "node:async_hooks";
import { type AnyElysia, Elysia } from "elysia";
import { scopedInstance } from "../instance.ts";
import { appendDevtoolsEvent } from "./hub.ts";

const OPERATION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface DevtoolsRequestContext {
  operationId: string | null;
  requestId: string;
}

interface StartedRequest {
  context: DevtoolsRequestContext;
  path: string;
  startedAt: number;
}

const requestContext = new AsyncLocalStorage<DevtoolsRequestContext>();
/** Opened by the plugin wrap before routing; filled once the owning runtime is known. */
const requestSlots = new AsyncLocalStorage<{ started: StartedRequest | undefined }>();

export function currentDevtoolsRequest(): DevtoolsRequestContext | undefined {
  return requestContext.getStore() ?? requestSlots.getStore()?.started?.context;
}

function startRequest(request: Request): StartedRequest {
  const rawOperationId = request.headers.get("x-furin-devtools-operation-id");
  const context: DevtoolsRequestContext = {
    operationId:
      rawOperationId && OPERATION_ID_PATTERN.test(rawOperationId) ? rawOperationId : null,
    requestId: crypto.randomUUID(),
  };
  const path = new URL(request.url).pathname;
  appendDevtoolsEvent({
    method: request.method,
    operationId: context.operationId,
    path,
    requestId: context.requestId,
    timestamp: Date.now(),
    type: "request.started",
  });
  return { context, path, startedAt: performance.now() };
}

export function runWithDevtoolsRequest<T>(request: Request, fn: () => T): T {
  const started = startRequest(request);
  return requestContext.run(started.context, () => {
    let result: T;
    try {
      result = fn();
    } catch (error) {
      appendFinished(undefined, started, 500);
      throw error;
    }
    if (!(result instanceof Promise)) {
      appendFinished(result, started, undefined);
      return result;
    }
    return result.then(
      (value) => {
        appendFinished(value, started, undefined);
        return value;
      },
      (error: unknown) => {
        appendFinished(undefined, started, 500);
        throw error;
      }
    ) as T;
  });
}

/**
 * Records each request in the devtools hub of the runtime that owns it. The
 * owner is only known once every Furin wrap has claimed the request, so the
 * wrap opens a slot and `onRequest` starts the recording.
 */
export function createDevtoolsRequestPlugin(
  shouldInstrument: (pathname: string, prefix: string) => boolean
): AnyElysia {
  return new Elysia({ name: "furin-devtools-request" })
    .wrap((fetch) => async (request, ...rest) => {
      const slot: { started: StartedRequest | undefined } = { started: undefined };
      let response: Response;
      try {
        response = await requestSlots.run(slot, () => fetch(request, ...rest));
      } catch (error) {
        if (slot.started) {
          appendFinished(undefined, slot.started, 500);
        }
        throw error;
      }
      if (slot.started) {
        appendFinished(response, slot.started, undefined);
      }
      return response;
    })
    .onRequest(({ request }) => {
      const slot = requestSlots.getStore();
      const runtime = scopedInstance();
      if (
        slot === undefined ||
        slot.started !== undefined ||
        runtime === undefined ||
        !shouldInstrument(new URL(request.url).pathname, runtime.prefix)
      ) {
        return;
      }
      slot.started = startRequest(request);
    });
}

function appendFinished(
  value: unknown,
  started: StartedRequest,
  failedStatus: number | undefined
): void {
  appendDevtoolsEvent({
    durationMs: performance.now() - started.startedAt,
    operationId: started.context.operationId,
    path: started.path,
    requestId: started.context.requestId,
    status: failedStatus ?? (value instanceof Response ? value.status : 200),
    timestamp: Date.now(),
    type: "request.finished",
  });
}
