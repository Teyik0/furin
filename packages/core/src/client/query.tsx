import {
  type Context,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
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

/**
 * Pages are ordinary store entries keyed by their URL: invalidation refetches every loaded page.
 * The hook owns only how many pages are shown; a new first page (changed filters) restarts at one.
 */
export function useInfiniteQuery<Result extends ReadResult>(
  page: (index: number) => LiveQuery<Result>,
  options: { next: (last: LiveData<Result>) => boolean }
): {
  error: Result["error"] | null;
  fetchNext: () => void;
  hasNext: boolean;
  isFetching: boolean;
  pages: LiveData<Result>[];
} {
  const first = page(0)[LIVE_QUERY];
  const context = useContext(QueryStoreContext);
  const store = context ?? first.reference.client;
  const firstUrl = store.readKey(first.reference, first.options);
  const [loaded, setLoaded] = useState({ count: 1, firstUrl });
  if (loaded.firstUrl !== firstUrl) {
    setLoaded({ count: 1, firstUrl });
  }
  const count = loaded.firstUrl === firstUrl ? loaded.count : 1;
  const urls = Array.from({ length: count }, (_, index) => {
    const { options: readOptions, reference } = page(index)[LIVE_QUERY];
    const url = store.readKey(reference, readOptions);
    store.bind(url, () => reference.load(readOptions), reference.client);
    return url;
  });
  // Encoded URLs never contain a newline: one stable string stands for the page list.
  const key = urls.join("\n");
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribes = key.split("\n").map((url) => store.subscribe(url, listener));
      return () => {
        for (const unsubscribe of unsubscribes) {
          unsubscribe();
        }
      };
    },
    [store, key]
  );
  // The store revision changes on every publish, so it versions all pages at once.
  useSyncExternalStore(subscribe, store.revision, store.revision);
  useEffect(() => {
    for (const url of key.split("\n")) {
      store.fetch(url);
    }
  }, [store, key]);
  const snapshots = urls.map((url) => store.snapshot(url));
  const pages: LiveData<Result>[] = [];
  for (const entry of snapshots) {
    if (entry.data === undefined) {
      break;
    }
    pages.push(entry.data as LiveData<Result>);
  }
  const last = pages.at(-1);
  const hasNext = pages.length === count && last !== undefined && options.next(last);
  const fetchNext = () => {
    if (hasNext) {
      // Calls in the same render see the same `count`: only the first one adds a page.
      setLoaded((previous) =>
        previous.firstUrl === firstUrl && previous.count === count
          ? { count: count + 1, firstUrl }
          : previous
      );
    }
  };
  return {
    error: (snapshots.find((entry) => entry.error !== null)?.error ?? null) as
      | Result["error"]
      | null,
    fetchNext,
    hasNext,
    isFetching: snapshots.some((entry) => entry.isFetching),
    pages,
  };
}
