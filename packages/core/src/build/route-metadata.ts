import { hasMixedLoaderModes } from "../server/render/loaders.ts";
import {
  resolveDocumentMode,
  resolveDocumentRevalidate,
  resolveRouteRevalidate,
} from "../server/router/patterns.ts";
import { mergeRouteSchemas } from "../server/router/schema-merge.ts";
import type { ResolvedRoute, RootLayout, SegmentBoundary } from "../server/router/types.ts";
import { isTypeBoxObjectSchema } from "../shared/elysia-contract.ts";
import { collectSearchDefaults, type SearchParamsInput } from "../shared/search-params.ts";

interface RouteBuildInfo {
  documentMode: ResolvedRoute["mode"];
  documentRevalidate: number | undefined;
  hasLayout: boolean;
  hasRequestLoader: boolean;
  hasStaticParams: boolean;
  mixed: boolean;
  queryKeys: string[] | null;
  revalidate: number | undefined;
  searchDefaults: SearchParamsInput | undefined;
}

/** Discovery results contain data only; application closures stay in the child. */
export interface BuildRoute
  extends Pick<
    ResolvedRoute,
    "mode" | "path" | "pattern" | "requestKeys" | "requestKeysByLoader" | "tags"
  > {
  build: RouteBuildInfo;
  routeChain: { layout: boolean; sourcePath?: string }[];
  segmentBoundaries: Pick<SegmentBoundary, "depth" | "path" | "errorPath" | "notFoundPath">[];
}

export type BuildRouteInput = BuildRoute | ResolvedRoute;
export type BuildRoot = Pick<RootLayout, "path" | "errorPath" | "notFoundPath"> & {
  hasRequestLoader: boolean;
};

export function rootHasRequestLoader(root: BuildRoot | RootLayout): boolean {
  return "route" in root ? root.route.requestLoader !== undefined : root.hasRequestLoader;
}

/** Also accepts live routes for the public buildClient API and dev hydration. */
export function routeBuildInfo(route: BuildRouteInput): RouteBuildInfo {
  if ("build" in route) {
    return route.build;
  }
  const chain = route.routeChain ?? [];
  const query = mergeRouteSchemas(chain, "query");
  let queryKeys: string[] | null = [];
  if (query !== undefined) {
    queryKeys = isTypeBoxObjectSchema(query) ? Object.keys(query.properties).toSorted() : null;
  }
  return {
    documentMode: resolveDocumentMode({ ...route, routeChain: chain }),
    documentRevalidate: resolveDocumentRevalidate({ ...route, routeChain: chain }),
    hasLayout: chain.some((entry) => !!entry.layout),
    hasRequestLoader: chain.some((entry) => entry.requestLoader !== undefined),
    hasStaticParams:
      route.page.staticParams !== undefined ||
      chain.some((entry) => entry.staticParams !== undefined),
    mixed: hasMixedLoaderModes({ ...route, routeChain: chain }),
    queryKeys,
    revalidate: resolveRouteRevalidate(route.page),
    searchDefaults: collectSearchDefaults(query),
  };
}

export function buildRouteMetadata(route: ResolvedRoute): BuildRoute {
  return {
    build: routeBuildInfo(route),
    mode: route.mode,
    path: route.path,
    pattern: route.pattern,
    requestKeys: route.requestKeys,
    requestKeysByLoader: route.requestKeysByLoader,
    routeChain: route.routeChain.map((entry) => ({
      layout: !!entry.layout,
      sourcePath: entry.sourcePath,
    })),
    segmentBoundaries: route.segmentBoundaries.map(({ depth, path, errorPath, notFoundPath }) => ({
      depth,
      path,
      errorPath,
      notFoundPath,
    })),
    tags: route.tags,
  };
}
