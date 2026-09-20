import type React from "react";
import { createElement } from "react";
import { type BoundaryOptions, FurinErrorBoundary, wrapSegmentBoundaries } from "../boundaries.tsx";
import type { RuntimeRoute } from "../internal/runtime-types.ts";
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
    : createElement(match.component, data);

  // Reconstruct the FULL route chain (shallow→deep, index 0 = root) by walking
  // parents. We keep every route — not only the ones declaring a layout — so a
  // route's chain index equals its directory depth. This mirrors the server's
  // `buildElement` exactly, which is what guarantees the per-segment boundaries
  // and layouts attach at the same depths on both sides (hydration parity).
  // Compacting to layouts-only (the previous approach) misaligned boundaries
  // and dropped the first nested layout whenever an ancestor lacked a layout.
  const chain: RuntimeRoute[] = [];
  let current: RuntimeRoute | undefined = match.pageRoute;
  while (current) {
    chain.unshift(current);
    current = current.parent;
  }

  // Index boundaries by depth for O(1) lookup. A boundary's `depth` maps 1:1 to
  // the route-chain index (depth 0 = root layout, handled separately below).
  const byDepth = new Map<number, ClientSegmentBoundary>();
  for (const segment of match.segmentBoundaries ?? []) {
    byDepth.set(segment.depth, segment);
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
    element = wrapSegmentBoundaries(element, byDepth.get(i), options);
    const Layout = chain[i]?.layout;
    if (Layout) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic route layouts have inferred props
      element = createElement(Layout, data as any, element);
    }
  }

  if (root) {
    // Depth 0 boundary wraps EVERYTHING below the root layout.
    element = wrapSegmentBoundaries(element, byDepth.get(0), options);
    if (root.layout) {
      // biome-ignore lint/suspicious/noExplicitAny: dynamic route layouts have inferred props
      element = createElement(root.layout, data as any, element);
    }
  }

  return element;
}
