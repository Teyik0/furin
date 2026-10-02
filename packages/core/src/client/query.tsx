import {
  type Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import {
  type QueryData,
  type QueryMethod,
  type QueryStore,
  readReference,
  readUrl,
} from "./query-store.ts";

// Entrypoints are bundled separately; they must share the context, never the cached data.
const QUERY_CONTEXT = Symbol.for("furin.query.context.v1");
const contextGlobal = globalThis as typeof globalThis & {
  [QUERY_CONTEXT]?: Context<QueryStore | null>;
};
export const QueryStoreContext = (contextGlobal[QUERY_CONTEXT] ??= createContext<QueryStore | null>(
  null
));

type MethodOptions<Method extends QueryMethod> = NonNullable<Parameters<Method>[0]>;
type MethodError<Method extends QueryMethod> = Awaited<ReturnType<Method>>["error"];
type Options<Method extends QueryMethod, Selected> = MethodOptions<Method> & {
  select?: (data: QueryData<Method>) => Selected;
};

export function useQuery<Method extends QueryMethod, Selected = QueryData<Method>>(
  method: Method,
  ...args: object extends MethodOptions<Method>
    ? [options?: Options<Method, Selected>]
    : [options: Options<Method, Selected>]
): { data: Selected | undefined; error: MethodError<Method> | null; isFetching: boolean } {
  const reference = readReference(method);
  if (!reference) {
    throw new Error("[furin] useQuery requires a GET from withSync().");
  }
  const context = useContext(QueryStoreContext);
  const store = context ?? reference.client;
  const [options] = args;
  const select = (options as { select?: (data: QueryData<Method>) => Selected } | undefined)
    ?.select;
  const url = readUrl(reference, options);
  store.bind(url, () => reference.load(options), reference.client);
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(url, listener),
    [store, url]
  );
  const snapshot = useCallback(() => store.snapshot(url), [store, url]);
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => {
    store.fetch(url);
  }, [store, url]);
  let data: Selected | undefined;
  if (state.data !== undefined) {
    data = select ? select(state.data as QueryData<Method>) : (state.data as Selected);
  }
  return {
    data,
    error: state.error as MethodError<Method> | null,
    isFetching: state.isFetching,
  };
}
