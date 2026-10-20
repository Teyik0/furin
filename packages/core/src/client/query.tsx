import {
  type Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useSyncExternalStore,
} from "react";
import { LIVE_QUERY, type LiveQuery, type QueryStore, type ReadResult } from "./query-store.ts";

// Entrypoints are bundled separately; they must share the context, never the cached data.
const QUERY_CONTEXT = Symbol.for("furin.query.context.v1");
const contextGlobal = globalThis as typeof globalThis & {
  [QUERY_CONTEXT]?: Context<QueryStore | null>;
};
export const QueryStoreContext = (contextGlobal[QUERY_CONTEXT] ??= createContext<QueryStore | null>(
  null
));

type LiveData<Result extends ReadResult> = NonNullable<Result["data"]>;

export function useQuery<Result extends ReadResult, Selected = LiveData<Result>>(
  query: LiveQuery<Result>,
  options?: { select?: (data: LiveData<Result>) => Selected }
): { data: Selected | undefined; error: Result["error"] | null; isFetching: boolean } {
  const { options: readOptions, reference } = query[LIVE_QUERY];
  const context = useContext(QueryStoreContext);
  const store = context ?? reference.client;
  const select = options?.select;
  const url = store.readKey(reference, readOptions);
  store.bind(url, () => reference.load(readOptions), reference.client);
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
    data = select ? select(state.data as LiveData<Result>) : (state.data as Selected);
  }
  return {
    data,
    error: state.error as Result["error"] | null,
    isFetching: state.isFetching,
  };
}
