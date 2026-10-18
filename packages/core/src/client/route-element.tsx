import { createElement, type ElementType, type ReactNode } from "react";
import type { ErrorComponent } from "../shared/error.ts";
import type { NotFoundComponent } from "../shared/not-found.ts";
import { pageKey } from "../shared/page-key.ts";
import { type RouteMatchFailure, serializedRouteMatches } from "../shared/route-matches.ts";
import { type BoundaryOptions, wrapSegmentBoundaries } from "./boundaries.tsx";
import { DefaultErrorFallback, DefaultNotFoundFallback } from "./default-screens.tsx";
import { FurinDocumentFallback } from "./document.tsx";
import type { RuntimeData, RuntimeRoute } from "./internal/runtime-types.ts";
import { withRouteSnapshot } from "./route-api.tsx";

/** A segment's own loader data, or why it has none. */
type RouteMatch = { loaderData: RuntimeData; status: "success" } | RouteMatchFailure;

export interface RouteBoundary {
  depth: number;
  error?: ErrorComponent;
  notFound?: NotFoundComponent;
}

export type RootBoundary = Omit<RouteBoundary, "depth">;

export interface RouteElementInput {
  /** Boundaries declared along the route, shallow → deep. */
  boundaries: readonly RouteBoundary[];
  /** Client reset wiring for the interleaved boundaries; `undefined` on the server. */
  boundaryOptions: BoundaryOptions | undefined;
  /** Route chain, index 0 = root. */
  chain: readonly RuntimeRoute[];
  /** Flat render data: the page's props plus `__furinMatches`. */
  data: RuntimeData;
  /** `undefined` when no page matched the URL. */
  page: { component: ElementType; pattern: string } | undefined;
  /** Passed to the rendered `error.tsx`. */
  reset: () => void;
  /** The root directory's own conventions, used when the root segment failed. */
  rootBoundary: RootBoundary | undefined;
}

function decodeRouteMatches(data: RuntimeData): RouteMatch[] {
  return serializedRouteMatches(data).map((match) =>
    match.status === "success"
      ? {
          loaderData: Object.fromEntries(
            Object.entries(match.fields).map(([field, key]) => [field, data[key]])
          ),
          status: "success",
        }
      : match
  );
}

/**
 * Picks the boundary that renders a failure of segment `index`. A segment's
 * own boundary sits inside its layout, so a layout failure bubbles to a
 * shallower boundary, as `error.tsx` does in the Next.js App Router. When no
 * deeper boundary applies, the root directory's boundary (else the built-in
 * screen) renders inside the root layout. The root segment has no layout
 * above it: its failure renders inside the minimal document (`depth: -1`).
 */
export function selectRouteBoundary<Kind extends "error" | "notFound">(
  boundaries: readonly RouteBoundary[],
  rootBoundary: RootBoundary | undefined,
  index: number,
  kind: Kind
): { component: RootBoundary[Kind]; depth: number } {
  const boundary = boundaries.findLast(
    (candidate) => candidate.depth < index && candidate[kind] !== undefined
  );
  return {
    component: boundary?.[kind] ?? rootBoundary?.[kind],
    depth: index === 0 ? -1 : (boundary?.depth ?? 0),
  };
}

function wrapLayout(route: RuntimeRoute | undefined, props: RuntimeData, element: ReactNode) {
  return route?.layout ? createElement(route.layout as ElementType, props, element) : element;
}

function failureElement(
  failure: RouteMatchFailure,
  component: ErrorComponent | NotFoundComponent | undefined,
  reset: () => void
): ReactNode {
  if (failure.status === "error") {
    return createElement((component as ErrorComponent | undefined) ?? DefaultErrorFallback, {
      error: failure.error,
      reset,
    });
  }
  return createElement((component as NotFoundComponent | undefined) ?? DefaultNotFoundFallback, {
    error: failure.error,
  });
}

/**
 * Builds the route's React tree from its matches. SSR, hydration and client
 * navigation all call this, so they render the same tree for the same payload.
 *
 * Every layout receives its own loader data merged over its ancestors', plus
 * `params`, `path` and `query`, whether the page succeeded or not. The page
 * receives the flat payload.
 */
export function resolveRouteElement(input: RouteElementInput): ReactNode {
  const { boundaries, chain, data, page } = input;
  const matches = decodeRouteMatches(data);
  const context = { params: data.params, path: data.path, query: data.query };
  const props: RuntimeData[] = [];
  let inherited: RuntimeData = {};
  for (const match of matches) {
    if (match.status !== "success") {
      break;
    }
    inherited = { ...inherited, ...match.loaderData };
    props.push({ ...inherited, ...context });
  }

  const index = matches.findIndex((match) => match.status !== "success");
  const failure = matches[index];
  if (failure && failure.status !== "success") {
    const { component, depth } = selectRouteBoundary(
      boundaries,
      input.rootBoundary,
      index,
      failure.status
    );
    let element = failureElement(failure, component, input.reset);
    for (let layout = depth; layout >= 0; layout -= 1) {
      element = wrapLayout(chain[layout], props[layout] ?? context, element);
    }
    return depth < 0 ? createElement(FurinDocumentFallback, null, element) : element;
  }

  if (!page) {
    throw new Error("[furin] internal invariant: a successful route render requires a page.");
  }
  const pageProps = Object.fromEntries(
    Object.entries(data).filter(([key]) => !key.startsWith("__furin"))
  );
  let element: ReactNode = createElement(page.component, {
    ...pageProps,
    key: pageKey(page.pattern, pageProps, chain.at(-1)?.remountDeps),
  });
  // Inside-out: a boundary sits inside the layout at its depth, so it catches
  // that layout's children but not the layout itself.
  for (let layout = chain.length - 1; layout >= 0; layout -= 1) {
    for (const boundary of boundaries.toReversed()) {
      if (boundary.depth === layout) {
        element = wrapSegmentBoundaries(element, boundary, input.boundaryOptions);
      }
    }
    element = wrapLayout(chain[layout], props[layout] ?? pageProps, element);
  }
  return withRouteSnapshot(element, page.pattern, pageProps);
}
