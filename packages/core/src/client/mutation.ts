import { EdenFetchError } from "@elysia/eden";
import { useCallback, useRef, useState } from "react";
import { createRequestId } from "./request-id.ts";
import {
  callWithOperation,
  finishMutation,
  inProgress,
  type MutationOperation,
  type OptimisticCache,
} from "./sync.ts";

interface MutationResponse {
  data: unknown;
  error: unknown;
}

type MutationMethod = (...args: never[]) => Promise<MutationResponse>;
type MutationData<Method extends MutationMethod> = Awaited<ReturnType<Method>>["data"];
type ErrorValue<Value> = Value extends { detail: string }
  ? Value
  : Value extends readonly unknown[]
    ? { detail: string }
    : Value extends object
      ? Omit<Value, "detail"> & { detail: string }
      : { detail: string };
type ApiError<Failure> = Failure extends { status: infer Status extends number; value: infer Value }
  ? Value extends { detail: string }
    ? Failure
    : EdenFetchError<Status, ErrorValue<Value>>
  : never;
type MutationError<Method extends MutationMethod> =
  | ApiError<NonNullable<Awaited<ReturnType<Method>>["error"]>>
  | EdenFetchError<0, { detail: string }>;

function isApiError(value: unknown): value is { status: number; value: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    typeof value.status === "number" &&
    "value" in value
  );
}

function normalizeMutationError<Method extends MutationMethod>(
  cause: unknown
): MutationError<Method> {
  const exception =
    isApiError(cause) && cause.status === 0 && cause.value instanceof Error ? cause.value : cause;
  if (isApiError(exception)) {
    const { value } = exception;
    if (
      typeof value === "object" &&
      value !== null &&
      "detail" in value &&
      typeof value.detail === "string"
    ) {
      return exception as MutationError<Method>;
    }
    const error = new EdenFetchError(exception.status, {
      ...(typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}),
      detail: typeof value === "string" && value ? value : "Mutation failed",
    });
    error.cause = exception;
    return error as MutationError<Method>;
  }
  const error = new EdenFetchError(0, {
    detail: exception instanceof Error ? exception.message : "Mutation failed",
  });
  error.cause = exception;
  return error;
}

interface MutationOptions<Method extends MutationMethod> {
  onError?: (error: MutationError<Method>) => void | Promise<void>;
  onSuccess?: (data: MutationData<Method>) => void | Promise<void>;
  /** Projects the mutation before it is sent; rolled back if the server rejects it. */
  optimistic?: (cache: OptimisticCache, ...args: Parameters<Method>) => void;
  /** Additional attempts after Furin's explicit in-progress response, with the same Idempotency-Key. */
  retry?: number;
}

function retryDelay(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("Retry-After");
  if (header !== null && header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
      return Math.max(0, date - Date.now());
    }
  }
  return Math.min(250 * 2 ** attempt, 4000);
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<boolean> {
  if (signal?.aborted) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const abort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** One key per mutate(), reused by every attempt, so a retry is never applied twice. */
async function runMutation<Method extends MutationMethod>(
  method: Method,
  args: Parameters<Method>,
  options: MutationOptions<Method> | undefined
): Promise<Awaited<ReturnType<Method>>> {
  const retry = options?.retry ?? 0;
  if (!Number.isSafeInteger(retry) || retry < 0) {
    throw new RangeError("[furin] retry must be a nonnegative integer.");
  }
  const optimistic = options?.optimistic;
  const operation: MutationOperation = {
    consumed: false,
    key: createRequestId(),
    optimistic: optimistic && ((cache) => optimistic(cache, ...args)),
  };
  // An Eden mutation verb takes (body, options): a fresh options object engages the sync plugin.
  const direct = typeof Reflect.get(method, "~path") === "string";
  const callArgs = direct ? [args[0], { ...(args[1] as object | undefined) }] : args;
  const signal = direct ? (callArgs[1] as { fetch?: RequestInit }).fetch?.signal : undefined;
  for (let attempt = 0; ; attempt += 1) {
    // The plugin's `after` records each consumed attempt's result on the operation.
    const pending = callWithOperation(
      operation,
      () => Reflect.apply(method, undefined, callArgs) as Promise<Awaited<ReturnType<Method>>>
    );
    if (!operation.consumed) {
      if (retry > 0 && process.env.NODE_ENV !== "production") {
        console.warn(
          "[furin] useMutation retry is disabled: the mutation did not call an Eden method with options synchronously, so its Idempotency-Key could not be attached."
        );
      }
      // biome-ignore lint/performance/noAwaitInLoops: retries are sequential attempts of one mutation.
      return await pending;
    }
    const settled = await pending.then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    );
    if (
      attempt >= retry ||
      !inProgress(operation.result) ||
      !(await delay(retryDelay(operation.result?.response, attempt), signal))
    ) {
      finishMutation(operation);
      if ("error" in settled) {
        throw settled.error;
      }
      return settled.value;
    }
  }
}

export function useMutation<Method extends MutationMethod>(
  method: Method,
  options?: MutationOptions<Method>
) {
  const [state, setState] = useState<{
    data: MutationData<Method> | undefined;
    error: MutationError<Method> | null;
    isPending: boolean;
  }>({ data: undefined, error: null, isPending: false });
  const latest = useRef<number>(0);
  const pending = useRef<number>(0);

  const mutateAsync = useCallback(
    async (...args: Parameters<Method>): Promise<MutationData<Method>> => {
      latest.current += 1;
      const invocation = latest.current;
      pending.current += 1;
      setState({ data: undefined, error: null, isPending: true });
      try {
        const result = await runMutation(method, args, options);
        if (result.error !== null) {
          if (
            "response" in result &&
            result.response === undefined &&
            result.error instanceof EdenFetchError &&
            result.error.status === 503 &&
            (result.error.value instanceof Error || typeof result.error.value === "string")
          ) {
            throw result.error.value;
          }
          throw result.error;
        }
        await options?.onSuccess?.(result.data);
        if (latest.current === invocation) {
          setState((previous) => ({ ...previous, data: result.data, error: null }));
        }
        return result.data;
      } catch (cause) {
        const failure = normalizeMutationError<Method>(cause);
        if (latest.current === invocation) {
          setState((previous) => ({ ...previous, data: undefined, error: failure }));
        }
        await options?.onError?.(failure);
        throw failure;
      } finally {
        pending.current -= 1;
        setState((previous) => ({ ...previous, isPending: pending.current > 0 }));
      }
    },
    [method, options]
  );
  const mutate = useCallback(
    (...args: Parameters<Method>): void => {
      mutateAsync(...args).catch(() => undefined);
    },
    [mutateAsync]
  );
  const reset = useCallback(() => {
    latest.current += 1;
    setState((previous) => ({ ...previous, data: undefined, error: null }));
  }, []);

  return { ...state, mutate, mutateAsync, reset };
}
