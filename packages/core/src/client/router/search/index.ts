import type { RouteManifest, RouteSearch, RouteTo } from "@teyik0/furin/link";
import { useCallback, useContext, useSyncExternalStore } from "react";
import {
  findSearchDefaultsForRouteTarget,
  type SearchParamsInput,
} from "../../../shared/search-params.ts";
import { buildHref } from "../link-utils.ts";
import { FALLBACK_SEARCH_STORE, SearchStoreContext } from "../search-store.ts";

export type SearchRouteTo = keyof RouteManifest extends never
  ? RouteTo
  : (string & {}) | keyof RouteManifest;

type SearchRouteSearch<To extends SearchRouteTo> = RouteSearch<To & RouteTo>;

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

function useSearchSelection<To extends SearchRouteTo, TSelected>(
  selector: (search: ResolvedRouteSearch<To>) => TSelected
): TSelected {
  const store = useContext(SearchStoreContext) ?? FALLBACK_SEARCH_STORE;

  const getSnapshot = useCallback(
    () => selector(store.getSnapshot().search as ResolvedRouteSearch<To>),
    [selector, store]
  );
  const getServerSnapshot = useCallback(
    () => selector(store.getServerSnapshot().search as ResolvedRouteSearch<To>),
    [selector, store]
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
  _from: To,
  selector?: (search: ResolvedRouteSearch<To>) => TSelected
): [ResolvedRouteSearch<To> | TSelected, SetSearch<To>] {
  const store = useContext(SearchStoreContext) ?? FALLBACK_SEARCH_STORE;
  const selected = useSearchSelection<To, ResolvedRouteSearch<To> | TSelected>((search) =>
    selector ? selector(search) : search
  );

  const setSearch = useCallback<SetSearch<To>>(
    (next, opts) => {
      const snapshot = store.getSnapshot();
      const search = snapshot.search as ResolvedRouteSearch<To>;
      const patch = typeof next === "function" ? next(search) : next;
      const merged = { ...search, ...patch } as SearchParamsInput;
      const pathname = pathnameFromLogicalHref(snapshot.currentHref);
      const searchDefaults = findSearchDefaultsForRouteTarget(pathname, snapshot.searchRoutes);
      const href = buildHref(pathname, merged, undefined, searchDefaults);
      return snapshot.navigate(href, opts);
    },
    [store]
  );

  return [selected, setSearch];
}
