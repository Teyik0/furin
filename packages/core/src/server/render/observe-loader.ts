import { currentInstrumentationRequest, emitLoaderFinished } from "../devtools/instrumentation.ts";
import { isDevelopment } from "../instance.ts";

export function observeLoader<T extends object>(
  run: () => T | Promise<T>,
  loader: string,
  path: string
): Promise<T> {
  const request = currentInstrumentationRequest();
  const startedAt = performance.now();
  let promise: Promise<T>;
  try {
    promise = Promise.resolve(run());
  } catch (error) {
    promise = Promise.reject(error);
  }
  if (!(request && isDevelopment())) {
    return promise;
  }
  return promise.then(
    (value) => {
      emitLoaderFinished({
        durationMs: performance.now() - startedAt,
        fieldNames: Object.keys(value),
        loader,
        operationId: request.operationId,
        path,
        requestId: request.requestId,
        status: "fulfilled",
      });
      return value;
    },
    (error: unknown) => {
      emitLoaderFinished({
        durationMs: performance.now() - startedAt,
        fieldNames: [],
        loader,
        operationId: request.operationId,
        path,
        requestId: request.requestId,
        status: "rejected",
      });
      throw error;
    }
  );
}
