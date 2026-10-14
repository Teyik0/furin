import type { RouteSearch, RouteTo } from "@teyik0/furin/link";
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import {
  findSearchDefaultsForRouteTarget,
  type SearchParamsInput,
} from "../../../shared/search-params.ts";
import { buildHref } from "../link-utils.ts";
import {
  FALLBACK_SEARCH_STORE,
  type SearchStore,
  SearchStoreContext,
  type SearchStoreSnapshot,
} from "../search-store.ts";

export type SearchRouteTo = RouteTo;

type SearchRouteSearch<To extends SearchRouteTo> = RouteSearch<To>;

export type EmptyRouteSearch = Record<PropertyKey, never>;

export type ResolvedRouteSearch<To extends SearchRouteTo> =
  SearchRouteSearch<To> extends never | undefined
    ? EmptyRouteSearch
    : NonNullable<SearchRouteSearch<To>>;

export type SetSearchInput<To extends SearchRouteTo> =
  | Partial<ResolvedRouteSearch<To>>
  | ((prev: ResolvedRouteSearch<To>) => Partial<ResolvedRouteSearch<To>>);

export interface SetSearchOptions {
  replace?: boolean;
  resetScroll?: boolean;
}

export type SetSearch<To extends SearchRouteTo> = (
  next: SetSearchInput<To>,
  opts?: SetSearchOptions
) => Promise<void>;

function pathnameFromLogicalHref(logicalHref: string): string {
  return new URL(logicalHref, "http://furin.local").pathname;
}

function assertSearchRoute(from: string, snapshot: SearchStoreSnapshot, store: SearchStore): void {
  if (
    (snapshot.currentPattern === undefined && store !== FALLBACK_SEARCH_STORE) ||
    (from !== snapshot.currentPattern && from !== pathnameFromLogicalHref(snapshot.currentHref))
  ) {
    throw new Error(`[furin] useSearch("${from}") does not match the current route.`);
  }
}

function useSearchSelection<To extends SearchRouteTo, TSelected>(
  from: To,
  selector: (search: ResolvedRouteSearch<To>) => TSelected
): TSelected {
  const store = useContext(SearchStoreContext) ?? FALLBACK_SEARCH_STORE;

  const selectSnapshot = useMemo(() => {
    let previous: { snapshot: SearchStoreSnapshot; selection: TSelected } | undefined;
    return (snapshot: SearchStoreSnapshot): TSelected => {
      assertSearchRoute(from, snapshot, store);
      if (previous?.snapshot === snapshot) {
        return previous.selection;
      }
      const selection = selector(snapshot.search as ResolvedRouteSearch<To>);
      previous = { snapshot, selection };
      return selection;
    };
  }, [from, selector, store]);
  const getSnapshot = useCallback(
    () => selectSnapshot(store.getSnapshot()),
    [selectSnapshot, store]
  );
  const getServerSnapshot = useCallback(
    () => selectSnapshot(store.getServerSnapshot()),
    [selectSnapshot, store]
  );

  return useSyncExternalStore(store.subscribe, getSnapshot, getServerSnapshot);
}

export function useSearch<To extends SearchRouteTo>(
  _from: To
): [ResolvedRouteSearch<To>, SetSearch<To>];
export function useSearch<To extends SearchRouteTo, TSelected>(
  _from: To,
  selector: (search: ResolvedRouteSearch<To>) => TSelected
): [TSelected, SetSearch<To>];
export function useSearch<To extends SearchRouteTo, TSelected>(
  from: To,
  selector?: (search: ResolvedRouteSearch<To>) => TSelected
): [ResolvedRouteSearch<To> | TSelected, SetSearch<To>] {
  const store = useContext(SearchStoreContext) ?? FALLBACK_SEARCH_STORE;
  const selected = useSearchSelection<To, ResolvedRouteSearch<To> | TSelected>(from, (search) =>
    selector ? selector(search) : search
  );

  const setSearch = useCallback<SetSearch<To>>(
    (next, opts) => {
      const snapshot = store.getSnapshot();
      try {
        assertSearchRoute(from, snapshot, store);
      } catch (error) {
        return Promise.reject(error);
      }
      const search = snapshot.search as ResolvedRouteSearch<To>;
      const patch = typeof next === "function" ? next(search) : next;
      const merged = { ...search, ...patch } as SearchParamsInput;
      const pathname = pathnameFromLogicalHref(snapshot.currentHref);
      const searchDefaults = findSearchDefaultsForRouteTarget(pathname, snapshot.searchRoutes);
      const href = buildHref(pathname, merged, undefined, searchDefaults);
      return snapshot.navigate(href, opts);
    },
    [from, store]
  );

  return [selected, setSearch];
}
