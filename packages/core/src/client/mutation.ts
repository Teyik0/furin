import { EdenFetchError } from "@elysia/eden";
import { useCallback, useRef, useState } from "react";

interface MutationResponse {
  data: unknown;
  error: unknown;
}

type MutationMethod = (...args: never[]) => Promise<MutationResponse>;
type MutationData<Method extends MutationMethod> = Awaited<ReturnType<Method>>["data"];
type MutationError<Method extends MutationMethod> =
  | Extract<NonNullable<Awaited<ReturnType<Method>>["error"]>, { status: number; value: unknown }>
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
  const exception = isApiError(cause) && cause.value instanceof Error ? cause.value : cause;
  if (isApiError(exception)) {
    return exception as MutationError<Method>;
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
        const result = (await Reflect.apply(method, undefined, args)) as Awaited<
          ReturnType<Method>
        >;
        if (result.error !== null) {
          if ("response" in result && result.response === undefined && isApiError(result.error)) {
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
