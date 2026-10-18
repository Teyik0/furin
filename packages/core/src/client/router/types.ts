import type { RouteMap } from "@teyik0/furin/routes";
import type React from "react";
import type { HeadOptions } from "../../client.ts";
import type { RouteContractOf } from "../../define-route.ts";
import type {
  ElysiaRouteLeaf,
  ElysiaRouteParams,
  ElysiaRouteQuery,
} from "../../shared/elysia-contract.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { NotFoundComponent } from "../../shared/not-found.ts";
import type { SearchParamsInput, SearchRouteMetadata } from "../../shared/search-params.ts";
import type { RuntimeRoute } from "../internal/runtime-types.ts";
import type { FurinServerErrorPayload } from "../server-error.ts";

/** Exact public projection of the generated route map, keyed by route pattern. */
export type RouteManifest = RouteMap;

/** Exact route patterns declared by the generated manifest. */
export type RoutePattern = keyof RouteManifest & string;

type HrefPath<Href extends string> = Href extends `${infer Path}?${string}`
  ? HrefPath<Path>
  : Href extends `${infer Path}#${string}`
    ? Path
    : Href;

type SegmentMatches<
  PatternSegment extends string,
  Segment extends string,
> = PatternSegment extends `:${string}`
  ? Segment extends ""
    ? false
    : true
  : [Segment] extends [PatternSegment]
    ? true
    : false;

/** Mirrors the router: `:param` matches one non-empty segment, `*` the rest. */
type PatternMatches<Pattern extends string, Path extends string> = Pattern extends "*"
  ? true
  : Pattern extends `${infer Head}/${infer Rest}`
    ? Path extends `${infer PathHead}/${infer PathRest}`
      ? SegmentMatches<Head, PathHead> extends true
        ? PatternMatches<Rest, PathRest>
        : false
      : false
    : Path extends `${string}/${string}`
      ? false
      : SegmentMatches<Pattern, Path>;

type MatchingPattern<Path extends string> = {
  [Pattern in RoutePattern]: PatternMatches<Pattern, Path> extends true ? Pattern : never;
}[RoutePattern];

/**
 * Route pattern(s) a destination resolves to: the exact key when `To` is a
 * declared pattern or static path, otherwise every pattern matching the
 * concrete path (search and hash ignored). `never` for unknown destinations.
 */
export type RoutePatternOf<To extends string> = To extends RoutePattern
  ? To
  : HrefPath<To> extends infer Path extends string
    ? Path extends RoutePattern
      ? Path
      : MatchingPattern<Path>
    : never;

/** The route module type a destination resolves to. */
export type RouteOf<To extends string> = RouteManifest[RoutePatternOf<To> & RoutePattern];

type IsExternalHref<To extends string> = To extends `//${string}`
  ? true
  : To extends `${infer Scheme}:${string}`
    ? Scheme extends "" | `${string}${"/" | "?" | "#"}${string}`
      ? false
      : true
    : false;

/**
 * Validates a destination literal: declared patterns, concrete paths matching
 * a pattern and external URLs (`https:`, `mailto:`, `//host`) pass; unknown
 * internal literals fail with a readable message. A value typed as plain
 * `string` cannot be checked statically and is accepted as-is.
 */
export type CheckedRouteTo<To extends string> = keyof RouteManifest extends never
  ? To
  : string extends To
    ? To
    : IsExternalHref<To> extends true
      ? To
      : [RoutePatternOf<To>] extends [never]
        ? `[furin] Unknown route "${To}". Use a route pattern, a path matching one, or an absolute URL.`
        : To;

/** `undefined` when a resolved contract field declares no keys. */
type DeclaredFields<Fields> = [Fields] extends [never]
  ? undefined
  : keyof Fields extends never
    ? undefined
    : Fields;

/**
 * Builder routes carry a resolved contract (inherited + own schemas). Plain
 * Elysia page modules fall back to their own route leaf.
 */
type ContractFields<Route> = [RouteContractOf<Route>] extends [never]
  ? Route extends { elysia: infer App }
    ? {
        params: ElysiaRouteParams<ElysiaRouteLeaf<App>>;
        query: ElysiaRouteQuery<ElysiaRouteLeaf<App>>;
      }
    : never
  : RouteContractOf<Route>;

type RouteSearchInput<Route> = DeclaredFields<ContractFields<Route>["query"]>;

type RouteParamsInput<Route> = DeclaredFields<ContractFields<Route>["params"]>;

type RouteParamInput<Value> = Value extends number ? string | number : Value;

/**
 * Literal route patterns for `to` completion, with a string fallback for concrete URLs.
 * Falls back to `string` when furin-env.d.ts has not been generated yet.
 * The string fallback also accepts concrete paths and external URLs.
 */
export type RouteTo = keyof RouteManifest extends never ? string : RoutePattern | (string & {});

/**
 * The typed search params for a given `to` pathname.
 * Falls back to a permissive record before RouteMap generation.
 */
export type RouteSearch<To extends RouteTo> = keyof RouteManifest extends never
  ? SearchParamsInput
  : string extends To
    ? SearchParamsInput
    : RouteSearchInput<RouteOf<To>>;

/**
 * URL values for a route's path params: schema numbers accept both `42` and
 * `"42"` (the URL always carries strings), everything else stays as declared.
 * Falls back to a permissive record before RouteMap generation.
 */
export type RouteParamsOf<To extends RouteTo> = keyof RouteManifest extends never
  ? Record<string, string | number>
  : string extends To
    ? Record<string, string | number>
    : RouteParamsInput<RouteOf<To>> extends infer Params
      ? Params extends object
        ? { [Key in keyof Params]: RouteParamInput<Params[Key]> }
        : undefined
      : undefined;

export type PreloadStrategy = false | "intent" | "viewport" | "render";

type LinkPathParamKeys<Path extends string> = Path extends `${infer Segment}/${infer Rest}`
  ? LinkPathParamKeys<Segment> | LinkPathParamKeys<Rest>
  : Path extends `:${infer Key}`
    ? Key
    : Path extends "*"
      ? "*"
      : never;

type LinkParams<To extends RouteTo> = [To] extends [RoutePattern]
  ? LinkPathParamKeys<To> extends never
    ? { params?: RouteParamsOf<To> }
    : {
        params: RouteParamsOf<To> &
          Required<
            Pick<RouteParamsOf<To>, Extract<LinkPathParamKeys<To>, keyof RouteParamsOf<To>>>
          >;
      }
  : { params?: RouteParamsOf<To> };

export interface LinkBaseProps<To extends RouteTo>
  extends Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href" | "children"> {
  /**
   * Extra props merged onto the anchor when the link is active.
   * `isActive` is also passed so one function can handle both states.
   * Styles and classNames from `activeProps` win over the static props.
   */
  activeProps?: (opts: { isActive: boolean }) => React.AnchorHTMLAttributes<HTMLAnchorElement>;
  /** Static children or a render function receiving active state. */
  children?: React.ReactNode | ((state: { isActive: boolean }) => React.ReactNode);
  /** Prevents navigation and prefetch; adds aria-disabled="true". The href stays intact for right-click. */
  disabled?: boolean;
  /** Optional URL fragment (without the #). */
  hash?: string;
  /**
   * Extra props merged onto the anchor when the link is NOT active.
   * Styles and classNames from `inactiveProps` win over the static props.
   */
  inactiveProps?: () => React.AnchorHTMLAttributes<HTMLAnchorElement>;
  /**
   * Typed path params for this route pattern: `/board/:boardId` with
   * `{ boardId: 42 }` renders `/board/42`. Auto-completed from the route's
   * params schema; schema numbers accept both `42` and `"42"`.
   */
  params?: RouteParamsOf<To>;
  /** Preload strategy. Default: "intent" (preload on hover/focus). */
  preload?: PreloadStrategy;
  /** Delay in ms before intent preload triggers. Default: 50. */
  preloadDelay?: number;
  /** How long a preloaded entry stays fresh (ms). Default: 30_000. */
  preloadStaleTime?: number;
  /** If true, uses history.replaceState instead of pushState (no new history entry). */
  replace?: boolean;
  /**
   * Whether to scroll after SPA navigation. Default: true.
   * - If the destination href has a `#hash`, scrolls to that element.
   * - Otherwise scrolls to the top of the page.
   * Set to `false` to suppress all scroll behaviour (e.g. tab/drawer navigation).
   */
  resetScroll?: boolean;
  /** Typed search params for this route. Auto-completed from the route's query schema. */
  search?: RouteSearch<To>;
  to: To;
}

export type LinkProps<To extends RouteTo = RouteTo> = LinkBaseProps<To> & LinkParams<To>;

/** Destinations accepted by structured navigation; validated by `CheckedRouteTo`. */
export type NavigationTo = RouteTo;

/**
 * Adds a required, self-describing property when `To` is an unknown internal
 * literal, so the compile error names the problem instead of `never`.
 */
export type RouteToCheck<To extends string> =
  CheckedRouteTo<To> extends To ? unknown : { readonly "~furinError": CheckedRouteTo<To> };

/**
 * Literal-shaped destinations (internal paths, scheme URLs). Distributing over
 * this template keeps `to` literals un-widened during inference, so each
 * union member stays paired with its own params and search.
 */
type DestinationLiteral = `/${string}` | `${string}:${string}`;

export type RouteTarget<To extends NavigationTo> = To extends DestinationLiteral
  ? { to: To; hash?: string; search?: RouteSearch<NoInfer<To>> } & LinkParams<NoInfer<To>> &
      RouteToCheck<NoInfer<To>>
  : string extends To
    ? {
        to: To;
        hash?: string;
        params?: Record<string, string | number>;
        search?: SearchParamsInput;
      }
    : { to: To; hash?: string } & RouteToCheck<NoInfer<To>>;

export interface NavigationOptions {
  replace?: boolean;
  resetScroll?: boolean;
}

export type NavigateInput<To extends NavigationTo> = RouteTarget<To> & NavigationOptions;
export type Navigate = <To extends NavigationTo>(next: NavigateInput<To>) => Promise<void>;

export interface RouterNavigate {
  (href: string, opts?: NavigationOptions): Promise<void>;
  <To extends NavigationTo>(next: NavigateInput<To>): Promise<void>;
}

export interface Prefetch {
  (href: string, opts?: { staleTime?: number }): void;
  <To extends NavigationTo>(next: RouteTarget<To> & { staleTime?: number }): void;
}

export type Router = Omit<RouterContextValue, "navigate" | "prefetch"> & {
  navigate: RouterNavigate;
  prefetch: Prefetch;
};

export interface RouterContextValue {
  /**
   * Sub-path prefix for static deployments (e.g. "/furin").
   * Empty string when the site is served from root.
   * Used by `Link` to build correct physical hrefs for the `<a>` element.
   */
  basePath: string;
  /** Current **logical** pathname + search (basePath stripped). Used by Link for active-state detection. */
  currentHref: string;
  /** Pattern of the currently rendered route, when a page route is matched. */
  currentPattern?: string;
  defaultPreload: PreloadStrategy;
  defaultPreloadDelay: number;
  defaultPreloadStaleTime: number;
  /**
   * Evicts one or more prefetch cache entries, mirroring a `revalidatePath()` call
   * made on the server. Called automatically by the `window.fetch` interceptor when
   * the server emits `X-Furin-Revalidate` headers.
   *
   * - `type: 'page'` (default) — exact URL match
   * - `type: 'layout'` — prefix match (path + all nested children)
   */
  invalidatePrefetch: (path: string, type: "page" | "layout") => void;
  isNavigating: boolean;
  navigate: (href: string, opts?: { replace?: boolean; resetScroll?: boolean }) => Promise<void>;
  prefetch: (href: string, opts?: { staleTime?: number }) => void;
  /**
   * Re-fetches the current page in-place: busts the prefetch cache entry, re-runs
   * loaders, and updates the rendered tree — without adding a history entry or
   * resetting scroll (unless `resetScroll: true` is passed).
   *
   * Prefer this over `navigate(window.location.pathname)` after a mutation.
   */
  refresh: (opts?: { resetScroll?: boolean }) => Promise<void>;
  /** Current server-resolved query params for the rendered route. */
  search: SearchParamsInput;
  /** Route-level search defaults used to build clean hrefs without default params. */
  searchRoutes: SearchRouteMetadata[];
}

/**
 * Client-side mirror of `SegmentBoundary` from router.ts. Unlike the server
 * version this does NOT carry the directory path — it's purely a (depth,
 * fallback) pair because the client never reads files, only renders.
 */
export interface ClientSegmentBoundary {
  depth: number;
  error?: ErrorComponent;
  /** False when a pathless directory shares index 0 but does not own the root fallback. */
  isRoot?: boolean;
  notFound?: NotFoundComponent;
}

export interface ClientRoute {
  component?: React.ComponentType<Record<string, unknown>>;
  load: () => Promise<{
    default: { component: React.ComponentType<Record<string, unknown>>; _route: RuntimeRoute };
    segmentBoundaries?: ClientSegmentBoundary[];
  }>;
  pageRoute?: RuntimeRoute;
  pattern: string;
  regex: RegExp;
  searchDefaults?: SearchParamsInput;
  /**
   * Per-segment boundary chain, ordered shallow→deep. Each `depth` maps 1:1
   * to the route-chain index used on the server side, so `buildPageElement`
   * can interleave boundaries at the exact same positions that the server
   * used in `buildElement` — guaranteeing hydration consistency.
   */
  segmentBoundaries?: ClientSegmentBoundary[];
}

/**
 * A ClientRoute that has been loaded — component and pageRoute are guaranteed defined.
 * The initial route is eagerly loaded in the hydrate entry; subsequent routes are loaded
 * on navigation via fetchPageState.
 */
export type LoadedClientRoute = ClientRoute & {
  component: React.ComponentType<Record<string, unknown>>;
  pageRoute: RuntimeRoute;
};

export interface RouterProviderProps {
  /**
   * When `true` (default), the router automatically re-fetches the current page
   * whenever a server `revalidatePath()` call targets it. The signal is the
   * `X-Furin-Revalidate` header detected on any `window.fetch` response.
   *
   * Set to `false` to opt out and call `router.refresh()` manually instead.
   */
  autoRefresh: boolean;
  /**
   * Sub-path prefix for static deployments (e.g. "/furin").
   * Must start with "/" and have no trailing slash.
   * Default: "" (site served from root).
   */
  basePath: string;
  defaultPreload: PreloadStrategy;
  defaultPreloadDelay: number;
  defaultPreloadStaleTime: number;
  initialData: Record<string, unknown>;
  /**
   * Slice 10 — server-logged error digest threaded from
   * `__FURIN_DATA__.__furinError.digest`. Forwarded onto the root-level
   * `FurinErrorBoundary` so that if a client-side error escapes the
   * per-segment boundaries (root layout crash, hydration mismatch, …), the
   * fallback UI surfaces the id a user would find in server logs.
   */
  initialDigest: string | undefined;
  /** Server loader error serialized into the initial SSR document. */
  initialError?: Omit<FurinServerErrorPayload, "message"> & { message?: string };
  /**
   * The route matched at hydration time. `null` is a valid value ONLY when
   * `initialNotFound` is also provided.
   */
  initialMatch: LoadedClientRoute | null;
  /**
   * When set, the provider boots into the inline not-found state as if a
   * prior SPA navigation hit a 404.
   */
  initialNotFound: { data?: unknown; message?: string } | undefined;
  /** Maximum number of prefetch cache entries. Oldest entry is evicted when exceeded. Default: 50. */
  prefetchCacheSize: number;
  root: RuntimeRoute | null;
  routes: ClientRoute[];
  /** Internal durable changes base path emitted by `furin({ sync })`. */
  syncPath?: string | undefined;
}

/** @internal Router state held inside RouterProvider. Exported so CacheEntry can reference it. */
export interface RouterState {
  data: Record<string, unknown>;
  /**
   * Set when the server's NDJSON payload carried an `__furinError` sentinel.
   */
  error?: FurinServerErrorPayload;
  /** The canonical href after server-side redirects (e.g. query-default redirect). */
  finalHref?: string;
  head?: HeadOptions;
  hydrateQueries?: ReturnType<import("../query-store.ts").QueryStore["captureHydration"]>;
  /**
   * The currently rendered route.
   *
   * `null` is a valid value ONLY when `notFound` is also set.
   */
  match: LoadedClientRoute | null;
  /**
   * Slice 8 — set when the matched route's loader threw `notFound()` on the server.
   */
  notFound?: { data?: unknown; message?: string };
  /**
   * Explicit boundary chain to use for the not-found render.
   */
  notFoundBoundaries?: ClientSegmentBoundary[] | undefined;
  querySeeds?: import("../../shared/sync-query.ts").QuerySeed[];
  title?: string;
}

/** @internal */
export interface CacheEntry {
  createdAt: number;
  promise: Promise<RouterState | null>;
  staleTime: number;
}

/**
 * Classification of a fetch response during SPA navigation. Returned by the
 * pure `classifySpaResponse` so `fetchPageState` stays a thin orchestrator.
 *
 * - `ok` — 2xx response with usable loader data; render normally.
 * - `not-found` — server signalled `__FURIN_DATA__.__furinStatus === 404`.
 * - `error` — server signalled `__FURIN_DATA__.__furinError`.
 * - `bail` — any other non-2xx without sentinels.
 *
 * @internal Exported for unit testing only.
 */
export type SpaResponseKind =
  | { kind: "ok" }
  | { kind: "not-found"; error: { data?: unknown; message?: string } }
  | { kind: "error"; error: { digest: string; message: string; status: number } }
  | { kind: "bail" };

/**
 * Root-level safety-net options forwarded onto the outermost
 * `FurinErrorBoundary` that wraps the entire RouterProvider tree.
 */
export interface RootBoundaryOptions {
  /**
   * Server-logged error id propagated from `__FURIN_DATA__.__furinError.digest`.
   */
  digest?: string;
  /** @internal Render the root fallback as a complete document. */
  document?: boolean;
  onReset?: () => void;
  resetKey?: string | number;
}
