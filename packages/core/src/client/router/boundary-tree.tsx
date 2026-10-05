import type React from "react";
import type { ElementType } from "react";
import { createElement } from "react";
import { pageKey } from "../../shared/page-key.ts";
import { type BoundaryOptions, FurinErrorBoundary, wrapSegmentBoundaries } from "../boundaries.tsx";
import type { RuntimeRoute } from "../internal/runtime-types.ts";
import { withRouteSnapshot } from "../route-api.tsx";
import { FurinServerError } from "../server-error.ts";
import { RouterContext } from "./context.ts";
import type {
  ClientSegmentBoundary,
  LoadedClientRoute,
  RootBoundaryOptions,
  RouterContextValue,
} from "./types.ts";

/**
 * Composes the outermost tree produced by `RouterProvider`:
 *
 *   <RouterContext.Provider value={context}>
 *     <FurinErrorBoundary digest onReset resetKey>
 *       {pageElement}
 *     </FurinErrorBoundary>
 *   </RouterContext.Provider>
 *
 * `RouterContext.Provider` is the OUTERMOST element so that a root-level
 * `error.tsx` rendered by the boundary can still call `useRouter()` / render
 * `<Link>` (the context is in scope above the boundary).
 *
 * @internal Exported for unit testing only.
 */
export function buildRouterTree(
  context: RouterContextValue,
  pageElement: React.ReactNode,
  options: RootBoundaryOptions
): React.ReactElement {
  return (
    <RouterContext.Provider value={context}>
      <FurinErrorBoundary {...options}>{pageElement}</FurinErrorBoundary>
    </RouterContext.Provider>
  );
}

/**
 * Internal helper component that throws a `FurinServerError` during render
 * so the nearest `<FurinErrorBoundary>` catches it and renders the user's
 * `error.tsx` (or the built-in default) — without forcing a full-page reload.
 */
function RouteErrorThrower({
  error,
}: {
  error: { digest: string; message: string; status: number };
}): React.ReactElement {
  throw new FurinServerError(error);
}

/** @internal Exported for unit testing only. */
export function buildPageElement(
  match: LoadedClientRoute,
  root: RuntimeRoute | null,
  data: Record<string, unknown>,
  options: BoundaryOptions | undefined,
  error: { digest: string; message: string; status: number } | undefined
): React.ReactNode {
  let element: React.ReactNode = error
    ? createElement(RouteErrorThrower, { error })
    : createElement(match.component, {
        ...data,
        key: pageKey(match.pattern, data, match.pageRoute.remountDeps),
      });

  // Reconstruct the FULL route chain (shallow→deep, index 0 = root) by walking
  // parents. Boundary depths refer to these indices, including routes without
  // layouts, so server and client attach boundaries at the same positions.
  const chain: RuntimeRoute[] = [];
  let current: RuntimeRoute | undefined = match.pageRoute;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  // Index boundaries by depth for O(1) lookup. A boundary's `depth` maps 1:1 to
  // the route-chain index (depth 0 = root layout, handled separately below).
  const byDepth = new Map<number, ClientSegmentBoundary[]>();
  for (const segment of match.segmentBoundaries ?? []) {
    const boundaries = byDepth.get(segment.depth) ?? [];
    boundaries.unshift(segment);
    byDepth.set(segment.depth, boundaries);
  }

  // When a root route is present it occupies chain index 0 and is wrapped
  // separately below (root layout + depth-0 boundary), mirroring the server's
  // `buildElement`. When `root` is null there is no separate root, so chain
  // index 0 is an ordinary route whose layout + boundary participate in the
  // loop too.
  const rootOffset = root ? 1 : 0;

  // Inside-out: at each non-root depth wrap the subtree with its same-depth
  // boundary (so the boundary sits INSIDE the layout), then wrap with the
  // layout itself when this route declares one.
  for (let i = chain.length - 1; i >= rootOffset; i -= 1) {
    for (const segment of byDepth.get(i) ?? []) {
      element = wrapSegmentBoundaries(element, segment, options);
    }
    const Layout = chain[i]?.layout;
    if (Layout) {
      element = createElement(Layout as ElementType, data, element);
    }
  }

  if (root) {
    // Depth 0 boundary wraps EVERYTHING below the root layout.
    for (const segment of byDepth.get(0) ?? []) {
      element = wrapSegmentBoundaries(element, segment, options);
    }
    if (root.layout) {
      element = createElement(root.layout as ElementType, data, element);
    }
  }

  return error ? element : withRouteSnapshot(element, match.pattern, data);
}
