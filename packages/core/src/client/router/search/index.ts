import type { RouteSearch, RouteTo } from "@teyik0/furin/link";
import { useCallback, useContext, useSyncExternalStore } from "react";
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

  const getSnapshot = useCallback(() => {
    const snapshot = store.getSnapshot();
    assertSearchRoute(from, snapshot, store);
    return selector(snapshot.search as ResolvedRouteSearch<To>);
  }, [from, selector, store]);
  const getServerSnapshot = useCallback(() => {
    const snapshot = store.getServerSnapshot();
    assertSearchRoute(from, snapshot, store);
    return selector(snapshot.search as ResolvedRouteSearch<To>);
  }, [from, selector, store]);

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
