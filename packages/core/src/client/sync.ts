import type { PluginTypeFn, Treaty, TreatyPlugin } from "@elysia/eden";
import type { RouteMap } from "@teyik0/furin/routes";
import type { AnyElysia } from "elysia";
import type { RouteLoaderData } from "../define-route.ts";
import {
  findOptimisticRuntime,
  type OptimisticRuntime,
  SYNC_REQUEST,
} from "./router/optimistic.ts";
import type { RouteSearch } from "./router/types.ts";

export interface OptimisticCache {
  update: <Path extends keyof RouteMap & string>(
    target: Path | { path: Path; search?: RouteSearch<Path> },
    transform: (loader: RouteLoaderData<RouteMap[Path]>) => RouteLoaderData<RouteMap[Path]>
  ) => void;
}

export interface SyncCallOptions {
  optimistic?: (cache: OptimisticCache) => void;
  /** Additional attempts for Furin's explicit in-progress response. Never retries ambiguous writes. */
  retry?: number;
}

export interface SyncClientOptions {
  retry?: number;
}

interface SyncPluginType extends PluginTypeFn {
  callOptions: SyncCallOptions;
  output: object;
}

interface MutationResult {
  error: { value?: unknown } | null;
  response?: Response;
}
interface Operation {
  method?: string;
  projection?: Projection;
  result?: MutationResult;
  runtime?: OptimisticRuntime;
}
interface Projection {
  outcome: "success" | "error" | "ambiguous";
  pending: number;
  response?: Response;
  runtime: OptimisticRuntime;
  token: ReturnType<OptimisticRuntime["begin"]>;
}
type Projections = Map<OptimisticRuntime, Map<string, Projection>>;
const OPERATION = Symbol("furin.sync.operation");
interface CallOptions extends SyncCallOptions {
  fetch?: RequestInit;
  headers?: HeaderSource;
  query?: object;
  [OPERATION]: Operation;
}
type HeaderSource =
  | HeadersInit
  | ((
      path: string,
      init: RequestInit
    ) => HeaderSource | undefined | Promise<HeaderSource | undefined>)
  | HeaderSource[];
type Callable = (...args: unknown[]) => unknown;
const MUTATIONS = new Set(["post", "put", "patch", "delete"]);

const plugin: TreatyPlugin<SyncPluginType> = {
  name: "furin-sync",
  before(context) {
    const options = context.options as CallOptions | undefined;
    const operation = options?.[OPERATION];
    if (!(operation && options)) {
      return;
    }
    if (!operation.runtime) {
      operation.runtime = findOptimisticRuntime(context.domain);
    }
    operation.method = context.method;
    if (operation.runtime) {
      options.fetch = { ...options.fetch, [SYNC_REQUEST]: true } as RequestInit;
    }
  },
  after(result, context) {
    const operation = (context.options as CallOptions | undefined)?.[OPERATION];
    if (operation) {
      operation.result = result;
    }
  },
};

async function resolveHeaders(
  source: HeaderSource | undefined,
  // biome-ignore lint/suspicious/noParametersOnlyUsedInRecursion: passed to Eden header callbacks.
  path: string,
  // biome-ignore lint/suspicious/noParametersOnlyUsedInRecursion: passed to Eden header callbacks.
  init: RequestInit
): Promise<Headers> {
  if (typeof source === "function") {
    return resolveHeaders(await source(path, init), path, init);
  }
  if (
    Array.isArray(source) &&
    !(source.length > 0 && Array.isArray(source[0]) && typeof source[0][0] === "string")
  ) {
    const headers = new Headers();
    for (const entry of source) {
      // biome-ignore lint/performance/noAwaitInLoops: header callbacks must retain Eden's ordering.
      const resolved = await resolveHeaders(entry as HeaderSource, path, init);
      resolved.forEach((value, name) => {
        headers.set(name, value);
      });
    }
    return headers;
  }
  return new Headers(source as HeadersInit | undefined);
}

function inProgress(result: MutationResult): boolean {
  const value = result.error?.value;
  return (
    result.response?.status === 409 &&
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "FURIN_MUTATION_IN_PROGRESS"
  );
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

async function runMutation(
  target: Callable,
  receiver: unknown,
  args: unknown[],
  clientOptions: SyncClientOptions | undefined,
  projections: Projections
): Promise<unknown> {
  const supplied = args[1] as Omit<CallOptions, typeof OPERATION> | undefined;
  const retry = supplied?.retry ?? clientOptions?.retry ?? 0;
  if (!Number.isSafeInteger(retry) || retry < 0) {
    throw new RangeError("[furin] retry must be a nonnegative integer.");
  }
  const operation: Operation = {};
  let key: string | undefined;
  const headers = async (path: string, init: RequestInit) => {
    const resolved = await resolveHeaders(supplied?.headers, path, init);
    const fetchHeaders = new Headers(supplied?.fetch?.headers);
    key ??=
      fetchHeaders.get("Idempotency-Key") ??
      resolved.get("Idempotency-Key") ??
      new Headers(init.headers).get("Idempotency-Key") ??
      crypto.randomUUID();
    resolved.set("Idempotency-Key", key);
    if (supplied?.fetch?.headers) {
      fetchHeaders.set("Idempotency-Key", key);
      options.fetch = { ...options.fetch, headers: fetchHeaders };
    }
    if (operation.runtime && !operation.projection) {
      const { runtime } = operation;
      const entries = projections.get(runtime) ?? new Map<string, Projection>();
      const identity = JSON.stringify([
        operation.method,
        path,
        key,
        supplied?.query && Object.entries(supplied.query).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      let projection = entries.get(identity);
      if (!projection) {
        projection = {
          pending: 0,
          outcome: "error",
          runtime,
          token: runtime.begin(supplied?.optimistic, () => {
            entries.delete(identity);
            if (entries.size === 0) {
              projections.delete(runtime);
            }
          }),
        };
        entries.set(identity, projection);
        projections.set(runtime, entries);
      }
      projection.pending += 1;
      operation.projection = projection;
    }
    return resolved;
  };
  const options: CallOptions = {
    ...supplied,
    [OPERATION]: operation,
    // Eden reads explicit content-type from this object again after serializing the body.
    headers: Object.assign(headers, {
      "content-type": (supplied?.headers as { "content-type"?: string } | undefined)?.[
        "content-type"
      ],
    }),
  };
  let result: MutationResult;
  let thrown: { error: unknown } | undefined;
  try {
    let attempt = 0;
    for (;;) {
      operation.result = undefined;
      thrown = undefined;
      try {
        // biome-ignore lint/performance/noAwaitInLoops: retries are sequential attempts of the same operation.
        result = (await Reflect.apply(target, receiver, [args[0], options])) as MutationResult;
      } catch (error) {
        if (!operation.result) {
          throw error;
        }
        ({ result } = operation);
        thrown = { error };
      }
      if (!inProgress(result) || attempt >= retry || options.fetch?.signal?.aborted) {
        break;
      }
      if (!(await delay(retryDelay(result.response, attempt), options.fetch?.signal))) {
        break;
      }
      attempt += 1;
    }
  } catch (error) {
    finishOperation(operation, undefined);
    throw error;
  }
  finishOperation(operation, result);
  if (thrown) {
    throw thrown.error;
  }
  return result;
}

function finishOperation(operation: Operation, result: MutationResult | undefined): void {
  const { projection } = operation;
  if (!projection) {
    return;
  }
  let outcome: "success" | "error" | "ambiguous" = "ambiguous";
  if (result?.error === null) {
    outcome = "success";
  } else if (
    result?.response &&
    result.response.status >= 400 &&
    result.response.status < 500 &&
    !inProgress(result)
  ) {
    outcome = "error";
  }
  if (outcome === "success" || (outcome === "ambiguous" && projection.outcome === "error")) {
    projection.outcome = outcome;
    projection.response = result?.response;
  }
  projection.pending -= 1;
  if (projection.pending === 0) {
    projection.runtime.finish(
      projection.token,
      projection.outcome,
      projection.response ?? result?.response
    );
  }
}

function wrapClient(
  client: Callable,
  method: string | undefined,
  options: SyncClientOptions | undefined,
  projections: Projections
): Callable {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property);
      return typeof value === "function"
        ? wrapClient(value as Callable, String(property), options, projections)
        : value;
    },
    apply(target, receiver, args) {
      if (method && MUTATIONS.has(method)) {
        return runMutation(target, receiver, args, options, projections);
      }
      const value = Reflect.apply(target, receiver, args);
      return typeof value === "function"
        ? wrapClient(value as Callable, undefined, options, projections)
        : value;
    },
  });
}

export function withSync<
  App extends AnyElysia,
  Head extends { [header: string]: unknown },
  Fns extends PluginTypeFn[],
>(
  client: Treaty.Instance<App, Head, Fns>,
  options?: SyncClientOptions
): Treaty.Instance<App, Head, [...Fns, SyncPluginType]> {
  return wrapClient(
    client.use(plugin) as unknown as Callable,
    undefined,
    options,
    new Map()
  ) as unknown as Treaty.Instance<App, Head, [...Fns, SyncPluginType]>;
}
