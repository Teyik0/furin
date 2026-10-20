// biome-ignore-all lint/performance/noBarrelFile: client/router barrel — public surface of the SPA router
export { buildRouterTree } from "./boundary-tree.tsx";
export { RouterContext, useRouter } from "./context.ts";
export {
  applyRevalidateHeader,
  buildHref,
  normalizeHref,
  shouldAutoRefreshPath,
  shouldInterceptClick,
  shouldRefetch,
  toLogical,
} from "./link-utils.ts";
export type { Navigate, NavigateInput } from "./navigation.ts";
export { useNavigate } from "./navigation.ts";
export { RouterProvider } from "./provider.tsx";
export type { SearchStore, SearchStoreSnapshot } from "./search-store.ts";
export { buildDataEndpoint, classifySpaResponse, detectStaticMode } from "./spa-response.ts";
export type {
  CacheEntry,
  CheckedRouteTo,
  ClientRoute,
  ClientSegmentBoundary,
  LinkProps,
  LoadedClientRoute,
  Prefetch,
  PreloadStrategy,
  RootBoundaryOptions,
  RouteManifest,
  RouteParamsOf,
  RoutePattern,
  RoutePatternOf,
  Router,
  RouterContextValue,
  RouterNavigate,
  RouterProviderProps,
  RouterState,
  RouteSearch,
  RouteSearchOutput,
  RouteTo,
  SpaResponseKind,
} from "./types.ts";
