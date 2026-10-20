import {
  type PluginCallContext,
  type PluginCallResult,
  type PluginTypeFn,
  type PluginVerbContext,
  type Treaty,
  type TreatyPlugin,
  treaty,
} from "@elysia/eden";
import type { RouteMap } from "@teyik0/furin/routes";
import type { RouteLoaderData } from "../define-route.ts";
import type { QueryIdentity } from "../shared/sync-query.ts";
import {
  currentQueryEnvironment,
  LIVE_QUERY,
  type LiveQuery,
  type QueryProjection,
  QueryStore,
  type ReadReference,
  type ReadResult,
} from "./query-store.ts";
import { createRequestId } from "./request-id.ts";
import {
  findOptimisticRuntime,
  type OptimisticRuntime,
  SYNC_REQUEST,
} from "./router/optimistic.ts";
import type { CheckedRouteTo, RouteOf, RouteSearch } from "./router/types.ts";

type LiveData<Result extends ReadResult> = NonNullable<Result["data"]>;

export interface OptimisticCache {
  update: {
    <Result extends ReadResult>(
      query: LiveQuery<Result>,
      transform: (data: LiveData<Result>) => LiveData<Result>
    ): void;
    <Pattern extends keyof RouteMap & string>(
      pattern: Pattern,
      transform: (loader: RouteLoaderData<RouteMap[Pattern]>) => RouteLoaderData<RouteMap[Pattern]>
    ): void;
    <Path extends string>(
      target: CheckedRouteTo<Path> | { path: CheckedRouteTo<Path>; search?: RouteSearch<Path> },
      transform: (loader: RouteLoaderData<RouteOf<Path>>) => RouteLoaderData<RouteOf<Path>>
    ): void;
  };
}

export interface SyncCallOptions {
  optimistic?: (cache: OptimisticCache) => void;
}

type LiveVerb<Get> = Get extends (...args: infer Args) => Promise<infer Result extends ReadResult>
  ? { live: (...args: Args) => LiveQuery<Result> }
  : object;

/** Every GET is live: its identity is its URL. */
type LiveOutput<Node, Head> = Node extends { get: unknown }
  ? { get: LiveVerb<Treaty.Sign<Node, Head & { [header: string]: unknown }>["get"]> }
  : object;

interface SyncPluginType extends PluginTypeFn {
  callOptions: SyncCallOptions;
  output: LiveOutput<this["node"], this["head"]>;
}

interface Projection {
  queries: QueryStore;
  queryToken: QueryProjection;
  runtime: OptimisticRuntime | undefined;
  token: ReturnType<OptimisticRuntime["begin"]> | undefined;
}

/** @internal One mutation: `useMutation` keeps its key and projection across retry attempts. */
export interface MutationOperation {
  consumed: boolean;
  key: string;
  optimistic: ((cache: OptimisticCache) => void) | undefined;
  projection?: Projection;
  result?: PluginCallResult;
}

interface Call {
  operation: MutationOperation;
  release: () => void;
  shared: boolean;
}

const calls = new WeakMap<PluginCallContext, Call>();
let ambient: MutationOperation | undefined;

/** @internal Eden runs plugin `before` hooks synchronously, before the call's first await. */
export function callWithOperation<Value>(operation: MutationOperation, call: () => Value): Value {
  ambient = operation;
  try {
    return call();
  } finally {
    ambient = undefined;
  }
}

export function inProgress(result: PluginCallResult | undefined): boolean {
  const value = result?.error?.value;
  return (
    result?.response?.status === 409 &&
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    value.code === "FURIN_MUTATION_IN_PROGRESS"
  );
}

// Eden hands plugins the client's config by identity: one per `treaty()` client.
const clientStores = new WeakMap<Treaty.Config, QueryStore>();
const edenClients = new WeakMap<Treaty.Config, object>();

function clientStore(config: Treaty.Config): QueryStore {
  let store = clientStores.get(config);
  if (!store) {
    store = new QueryStore(typeof window === "undefined" ? undefined : window.location.origin);
    clientStores.set(config, store);
  }
  return store;
}

function mutationStore(
  context: PluginCallContext,
  runtime: OptimisticRuntime | undefined
): QueryStore {
  return currentQueryEnvironment()?.store ?? runtime?.queries ?? clientStore(context.config);
}

function applyInvalidations(queries: QueryStore, response: Response | undefined): void {
  const invalidations = response?.headers.get("x-furin-queries");
  if (invalidations) {
    queries.invalidate(JSON.parse(invalidations) as QueryIdentity[]);
  }
}

/** Verbs cannot reach the client they were called on: rebuild it (without plugins) per config. */
function edenGet(context: PluginVerbContext): ReadReference["load"] {
  let client = edenClients.get(context.config);
  if (!client) {
    client = treaty(context.elysia ?? context.domain, context.config);
    edenClients.set(context.config, client);
  }
  // Verb paths carry raw param values; Eden encodes params only when they are called.
  return context.paths.reduce<object>(
    (node, segment) => Reflect.get(node, encodeURIComponent(segment)),
    client
  ) as ReadReference["load"];
}

function readLive({ [LIVE_QUERY]: { options, reference } }: LiveQuery<ReadResult>) {
  const environment = currentQueryEnvironment();
  if (typeof window === "undefined" && !environment) {
    return reference.load(options);
  }
  const store =
    environment?.store ??
    findOptimisticRuntime(new URL(reference.url).origin)?.queries ??
    reference.client;
  const url = store.readKey(reference, options);
  const epoch = store.generation();
  store.bind(url, () => reference.load(options), reference.client);
  const version = store.version(url);
  return reference.load(options).then((result) => {
    store.observe(url, result, epoch, version);
    environment?.onRead();
    return result;
  });
}

function queryProjectionCache(
  queries: QueryStore,
  token: QueryProjection,
  routeCache: OptimisticCache
): OptimisticCache {
  return {
    update(
      destination: LiveQuery<ReadResult> | string | { path: string },
      transform: (data: unknown) => unknown
    ) {
      if (typeof destination === "object" && LIVE_QUERY in destination) {
        const { options, reference } = destination[LIVE_QUERY];
        const url = queries.readKey(reference, options);
        queries.bind(url, () => reference.load(options), reference.client);
        queries.update(token, url, transform);
      } else {
        Reflect.apply(routeCache.update, routeCache, [destination, transform]);
      }
    },
  } as unknown as OptimisticCache;
}

function beginProjection(
  context: PluginCallContext,
  runtime: OptimisticRuntime | undefined,
  optimistic: (cache: OptimisticCache) => void
): Projection {
  const queries = mutationStore(context, runtime);
  const queryToken = queries.begin();
  const project = (routeCache: OptimisticCache) =>
    optimistic(queryProjectionCache(queries, queryToken, routeCache));
  const token = runtime?.begin(project, undefined, () => queryToken.transforms.size > 0);
  if (!runtime) {
    project({ update: () => undefined } as OptimisticCache);
  }
  return { queries, queryToken, runtime, token };
}

/** @internal Settles the projection with the last attempt's result and applies invalidations. */
export function finishMutation({ projection, result }: MutationOperation): void {
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
  applyInvalidations(projection.queries, result?.response);
  projection.queries.finish(projection.queryToken, outcome);
  if (projection.runtime && projection.token) {
    projection.runtime.finish(projection.token, outcome, result?.response);
  }
}

interface PendingKeys {
  queue: string[];
  restore: () => void;
}
const pendingKeys = new WeakMap<object, PendingKeys>();

function injectKeys(
  options: { headers?: unknown },
  runtime: OptimisticRuntime | undefined
): PendingKeys {
  const queue: string[] = [];
  const hadHeaders = Object.hasOwn(options, "headers");
  const original = options.headers;
  const restore = () => {
    pendingKeys.delete(options);
    if (hadHeaders) {
      options.headers = original;
    } else {
      Reflect.deleteProperty(options, "headers");
    }
  };
  options.headers = (_path: string, init: RequestInit) => {
    const key = queue.shift();
    if (queue.length === 0) {
      restore();
    }
    if (runtime) {
      Object.assign(init, { [SYNC_REQUEST]: true });
    }
    // Later sources win: a caller's explicit Idempotency-Key overrides this one.
    return [{ "idempotency-key": key }, ...(Array.isArray(original) ? original : [original])];
  };
  return { queue, restore };
}

/**
 * Eden passes the caller's options by reference and reads `headers` once per call, after an
 * await. Calls sharing an options object each take the next key from one injected source, and
 * the caller's own value is put back once every pending call has read it.
 */
function attachKey(
  options: { headers?: unknown },
  key: string,
  runtime: OptimisticRuntime | undefined
): () => void {
  const pending = pendingKeys.get(options) ?? injectKeys(options, runtime);
  pendingKeys.set(options, pending);
  pending.queue.push(key);
  // A call that failed before Eden read its headers releases its key.
  return () => {
    const index = pending.queue.indexOf(key);
    if (index !== -1) {
      pending.queue.splice(index, 1);
      if (pending.queue.length === 0) {
        pending.restore();
      }
    }
  };
}

export const furinSync: TreatyPlugin<SyncPluginType> = {
  name: "furin-sync",
  verbs: {
    live(context, options: unknown): LiveQuery<ReadResult> {
      // Eden dispatches a verb on any call whose last segment matches, route segments included.
      if (context.paths.at(-1) !== "get") {
        throw new Error(
          `[furin] "live" is reserved by furinSync for \`.get.live()\`: ${context.path}/live cannot be called as a route segment.`
        );
      }
      const reference: ReadReference = {
        client: clientStore(context.config),
        load: edenGet(context),
        url: `${context.domain}/${context.paths.slice(0, -1).map(encodeURIComponent).join("/")}`,
      };
      // Like the promise `.get()` returns: one read, started when first awaited.
      let read: Promise<ReadResult> | undefined;
      const start = () => {
        read ??= readLive(query);
        return read;
      };
      const query: LiveQuery<ReadResult> = {
        [LIVE_QUERY]: { options, reference },
        [Symbol.toStringTag]: "LiveQuery",
        // biome-ignore lint/suspicious/noThenProperty: a live query is awaited like the GET it wraps.
        then: (onFulfilled, onRejected) => start().then(onFulfilled, onRejected),
        catch: (onRejected) => start().catch(onRejected),
        finally: (onFinally) => start().finally(onFinally),
      };
      return query;
    },
  },
  before(context) {
    const options = context.options as (SyncCallOptions & { headers?: unknown }) | undefined;
    if (!options) {
      return;
    }
    const shared = ambient;
    ambient = undefined;
    const operation = shared ?? { consumed: false, key: createRequestId(), optimistic: undefined };
    operation.consumed = true;
    const runtime = findOptimisticRuntime(context.domain);
    operation.projection ??= beginProjection(context, runtime, (cache) => {
      operation.optimistic?.(cache);
      options.optimistic?.(cache);
    });
    calls.set(context, {
      operation,
      release: attachKey(options, operation.key, runtime),
      shared: shared !== undefined,
    });
  },
  after(result, context) {
    const call = calls.get(context);
    if (!call) {
      applyInvalidations(
        mutationStore(context, findOptimisticRuntime(context.domain)),
        result.response
      );
      return;
    }
    call.release();
    call.operation.result = result;
    // useMutation settles a shared operation once its last attempt is known.
    if (!call.shared) {
      finishMutation(call.operation);
    }
  },
};
