import {
  type PluginTypeFn,
  type PluginVerbContext,
  type Treaty,
  type TreatyPlugin,
  treaty,
} from "@elysia/eden";
import type { RouteMap, RoutePatternMap } from "@teyik0/furin/routes";
import type { AnyElysia } from "elysia";
import type { RouteLoaderData } from "../define-route.ts";
import type { QueryIdentity } from "../shared/sync-query.ts";
import {
  currentQueryEnvironment,
  QUERY_REFERENCE,
  type QueryData,
  type QueryMethod,
  type QueryProjection,
  QueryStore,
  type ReadReference,
  type ReadResult,
  readReference,
} from "./query-store.ts";
import { createRequestId } from "./request-id.ts";
import {
  findOptimisticRuntime,
  type OptimisticRuntime,
  SYNC_REQUEST,
} from "./router/optimistic.ts";
import type { RouteSearch } from "./router/types.ts";

export interface OptimisticCache {
  update: {
    <Method extends QueryMethod>(
      method: Method,
      transform: (data: QueryData<Method>) => QueryData<Method>,
      ...args: object extends NonNullable<Parameters<Method>[0]>
        ? [options?: NonNullable<Parameters<Method>[0]>]
        : [options: NonNullable<Parameters<Method>[0]>]
    ): void;
    <Pattern extends keyof RoutePatternMap & string>(
      pattern: Pattern,
      transform: (
        loader: RouteLoaderData<RoutePatternMap[Pattern]>
      ) => RouteLoaderData<RoutePatternMap[Pattern]>
    ): void;
    <Path extends keyof RouteMap & string>(
      target: Path | { path: Path; search?: RouteSearch<Path> },
      transform: (loader: RouteLoaderData<RouteMap[Path]>) => RouteLoaderData<RouteMap[Path]>
    ): void;
  };
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
  output: this["node"] extends { get: object }
    ? { get: { readonly [QUERY_REFERENCE]: true } }
    : object;
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
  queries: QueryStore;
  queryToken: QueryProjection;
  remove: () => void;
  response?: Response;
  runtime?: OptimisticRuntime;
  token?: ReturnType<OptimisticRuntime["begin"]>;
}
type Projections = Map<object, Map<string, Projection>>;

function queryProjectionCache(
  queries: QueryStore,
  token: QueryProjection,
  routeCache: OptimisticCache
): OptimisticCache {
  return {
    update(
      destination: QueryMethod | string | { path: string },
      transform: (data: unknown) => unknown,
      queryOptions?: object
    ) {
      if (typeof destination === "function") {
        const reference = readReference(destination);
        const url = queries.readKey(reference, queryOptions);
        queries.bind(url, () => reference.load(queryOptions), reference.client);
        queries.update(token, url, transform);
      } else {
        Reflect.apply(routeCache.update, routeCache, [destination, transform]);
      }
    },
  } as unknown as OptimisticCache;
}
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
  verbs: { __furinQuery: (context) => context },
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
  projections: Projections,
  clientQueries: QueryStore
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
    // Eden reads this property after serializing the body.
    Object.assign(headers, { "content-type": resolved.get("content-type") ?? undefined });
    const fetchHeaders = new Headers(supplied?.fetch?.headers);
    key ??=
      fetchHeaders.get("Idempotency-Key") ??
      resolved.get("Idempotency-Key") ??
      new Headers(init.headers).get("Idempotency-Key") ??
      createRequestId();
    resolved.set("Idempotency-Key", key);
    if (supplied?.fetch?.headers) {
      fetchHeaders.set("Idempotency-Key", key);
      options.fetch = { ...options.fetch, headers: fetchHeaders };
    }
    if (!operation.projection) {
      const { runtime } = operation;
      const queries = currentQueryEnvironment()?.store ?? runtime?.queries ?? clientQueries;
      const owner = runtime ?? queries;
      const entries = projections.get(owner) ?? new Map<string, Projection>();
      const identity = JSON.stringify([
        operation.method,
        path,
        key,
        supplied?.query && Object.entries(supplied.query).sort(([a], [b]) => a.localeCompare(b)),
      ]);
      let projection = entries.get(identity);
      if (!projection) {
        const queryToken = queries.begin();
        const onRemove = () => {
          entries.delete(identity);
          if (entries.size === 0) {
            projections.delete(owner);
          }
        };
        queryToken.onRemove = onRemove;
        const optimistic = (routeCache: OptimisticCache) =>
          supplied?.optimistic?.(queryProjectionCache(queries, queryToken, routeCache));
        projection = {
          remove: onRemove,
          pending: 0,
          outcome: "error",
          runtime,
          queries,
          queryToken,
          token: runtime?.begin(optimistic, onRemove, () => queryToken.transforms.size > 0),
        };
        if (!runtime) {
          optimistic({ update: () => undefined } as OptimisticCache);
        }
        entries.set(identity, projection);
        projections.set(owner, entries);
      }
      projection.pending += 1;
      operation.projection = projection;
    }
    return resolved;
  };
  const options: CallOptions = {
    ...supplied,
    [OPERATION]: operation,
    headers,
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
    if (!projection.runtime && projection.queryToken.transforms.size === 0) {
      projection.remove();
    }
    const invalidations = (projection.response ?? result?.response)?.headers.get("x-furin-queries");
    if (invalidations) {
      projection.queries.invalidate(JSON.parse(invalidations) as QueryIdentity[]);
    }
    projection.queries.finish(projection.queryToken, projection.outcome);
    if (projection.runtime && projection.token) {
      projection.runtime.finish(
        projection.token,
        projection.outcome,
        projection.response ?? result?.response
      );
    }
  }
}

function wrapClient(
  client: Callable,
  method: string | undefined,
  options: SyncClientOptions | undefined,
  projections: Projections,
  queries: QueryStore,
  reference?: ReadReference
): Callable {
  return new Proxy(client, {
    get(target, property) {
      if (property === QUERY_REFERENCE && reference) {
        return reference;
      }
      const value = Reflect.get(target, property);
      if (property === "get" && typeof value === "function") {
        const context = Reflect.apply(
          Reflect.get(target, "__furinQuery"),
          target,
          []
        ) as PluginVerbContext;
        const url = `${context.domain}/${context.paths.map(encodeURIComponent).join("/")}`;
        const read: ReadReference = {
          client: queries,
          url,
          load: (readOptions) => Reflect.apply(value, target, [readOptions]) as Promise<ReadResult>,
        };
        return wrapClient(value as Callable, "get", options, projections, queries, read);
      }
      return typeof value === "function"
        ? wrapClient(value as Callable, String(property), options, projections, queries)
        : value;
    },
    apply(target, receiver, args) {
      if (method && MUTATIONS.has(method)) {
        return runMutation(target, receiver, args, options, projections, queries);
      }
      if (reference && method === "get") {
        const environment = currentQueryEnvironment();
        if (typeof window === "undefined" && !environment) {
          return reference.load(args[0]);
        }
        const store =
          environment?.store ??
          findOptimisticRuntime(new URL(reference.url).origin)?.queries ??
          queries;
        const url = store.readKey(reference, args[0]);
        const epoch = store.generation();
        store.bind(url, () => reference.load(args[0]), reference.client);
        const version = store.version(url);
        return reference.load(args[0]).then((result) => {
          store.observe(url, result, epoch, version);
          environment?.onRead();
          return result;
        });
      }
      const value = Reflect.apply(target, receiver, args);
      return typeof value === "function"
        ? wrapClient(value as Callable, undefined, options, projections, queries)
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
    new Map(),
    new QueryStore(typeof window === "undefined" ? undefined : window.location.origin)
  ) as unknown as Treaty.Instance<App, Head, [...Fns, SyncPluginType]>;
}

export function createClient<
  const App extends AnyElysia,
  Head extends { [header: string]: unknown } = { [header: string]: never },
>(domain: string | App, options?: Treaty.Config<Head> & SyncClientOptions) {
  const { retry, ...eden } = options ?? {};
  return withSync(treaty<App, Head>(domain, eden), { retry });
}
