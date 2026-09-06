// biome-ignore-all lint/performance/noBarrelFile: client/router barrel — public surface of the SPA router
export { buildPageElement, buildRouterTree } from "./boundary-tree.tsx";
export { CLIENT_FALLBACK_ROUTER, RouterContext, useRouter } from "./context.ts";
export {
  generateHistoryKey,
  getHistoryKey,
  isStaleDeployResponse,
  SCROLL_STORAGE_KEY,
  saveScrollPosition,
} from "./history.ts";
export {
  applyRevalidateHeader,
  buildHref,
  decodeHashFragment,
  isSameOriginFetchResult,
  navigationHrefPolicy,
  normalizeHref,
  normalizePath,
  shouldAutoRefreshPath,
  shouldInterceptClick,
  shouldRefetch,
  stripHashFromHref,
  TRAILING_SLASHES_RE,
  toLogical,
} from "./link-utils.ts";
export type { Navigate, NavigateInput } from "./navigation.ts";
export { useNavigate } from "./navigation.ts";
export { RouterProvider } from "./provider.tsx";
export type { SearchStore, SearchStoreSnapshot } from "./search-store.ts";
export {
  createSearchStore,
  FALLBACK_SEARCH_STORE,
  SearchStoreContext,
  searchSnapshotFromRouterContext,
} from "./search-store.ts";
export {
  buildDataEndpoint,
  buildNotFoundPageElement,
  classifySpaResponse,
  detectStaticMode,
  parsePageResponse,
  pickDeepestNotFound,
} from "./spa-response.ts";
export type {
  CacheEntry,
  ClientRoute,
  ClientSegmentBoundary,
  LinkProps,
  LoadedClientRoute,
  PreloadStrategy,
  RootBoundaryOptions,
  RouteManifest,
  RouteParamsOf,
  RouterContextValue,
  RouterProviderProps,
  RouterState,
  RouteSearch,
  RouteTo,
  SpaResponseKind,
} from "./types.ts";
