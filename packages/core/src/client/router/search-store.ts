import { createContext } from "react";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import { navigationHrefPolicy } from "./link-utils.ts";
import type { RouterContextValue } from "./types.ts";

export interface SearchStoreSnapshot {
  currentHref: string;
  currentPattern: string | undefined;
  navigate: RouterContextValue["navigate"];
  search: SearchParamsInput;
  searchRoutes: SearchRouteMetadata[];
}

type SearchStoreListener = () => void;

export interface SearchStore {
  flush: () => void;
  getServerSnapshot: () => SearchStoreSnapshot;
  getSnapshot: () => SearchStoreSnapshot;
  setSnapshot: (next: SearchStoreSnapshot) => void;
  subscribe: (listener: SearchStoreListener) => () => void;
}

function searchSnapshotChanged(a: SearchStoreSnapshot, b: SearchStoreSnapshot): boolean {
  return (
    a.currentHref !== b.currentHref ||
    a.currentPattern !== b.currentPattern ||
    a.navigate !== b.navigate ||
    a.search !== b.search ||
    a.searchRoutes !== b.searchRoutes
  );
}

export function createSearchStore(initialSnapshot: SearchStoreSnapshot): SearchStore {
  let snapshot = initialSnapshot;
  let version = 0;
  let flushedVersion = 0;
  const listeners = new Set<SearchStoreListener>();

  return {
    flush: () => {
      if (flushedVersion === version) {
        return;
      }
      flushedVersion = version;
      for (const listener of [...listeners]) {
        listener();
      }
    },
    getServerSnapshot: () => snapshot,
    getSnapshot: () => snapshot,
    setSnapshot: (next) => {
      if (!searchSnapshotChanged(snapshot, next)) {
        return;
      }
      snapshot = next;
      version += 1;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export function searchSnapshotFromRouterContext(context: RouterContextValue): SearchStoreSnapshot {
  return {
    currentHref: context.currentHref,
    currentPattern: context.currentPattern,
    navigate: context.navigate,
    search: context.search,
    searchRoutes: context.searchRoutes,
  };
}

export const FALLBACK_SEARCH_STORE = createSearchStore({
  currentHref: "/",
  currentPattern: undefined,
  navigate: (href, _opts) => {
    if (typeof window !== "undefined") {
      if (navigationHrefPolicy(href, window.location.origin) === "blocked") {
        return Promise.reject(new Error("[furin] Unsafe navigation URL."));
      }
      window.location.href = href;
    }
    return Promise.resolve();
  },
  search: {},
  searchRoutes: [],
});

export const SearchStoreContext = createContext<SearchStore | null>(null);
