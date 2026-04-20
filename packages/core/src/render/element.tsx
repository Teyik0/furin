import type { ReactNode } from "react";
import type { RuntimeRoute } from "../client";
import type { ErrorComponent } from "../error";
import type { FurinNotFoundError, NotFoundComponent } from "../not-found";
import type { ResolvedRoute, SegmentBoundary } from "../router";
import { FurinErrorBoundary, FurinNotFoundBoundary } from "./boundaries.tsx";
import { DefaultErrorScreen, DefaultNotFoundScreen } from "./default-screens.tsx";

/**
 * Wraps `inner` with the boundary components declared at a single segment
 * depth, if any. The ordering is deliberate:
 *
 *   <FurinErrorBoundary>
 *     <FurinNotFoundBoundary>{inner}</FurinNotFoundBoundary>
 *   </FurinErrorBoundary>
 *
 * FurinErrorBoundary must be OUTSIDE FurinNotFoundBoundary at the same depth:
 * the error boundary RE-THROWS FurinNotFoundError from render so an ancestor
 * not-found boundary can catch it. Placing the not-found boundary inside
 * would mean the same-depth error boundary catches a notFound() throw first
 * (it still latches onto the error in state), and while it re-throws in
 * render, the re-throw would not find a NotFoundBoundary deeper than itself
 * — it needs one higher up the tree.
 */
function wrapInBoundaries(inner: ReactNode, segment: SegmentBoundary | undefined): ReactNode {
  if (!segment) {
    return inner;
  }
  let wrapped: ReactNode = inner;
  if (segment.notFound) {
    wrapped = <FurinNotFoundBoundary fallback={segment.notFound}>{wrapped}</FurinNotFoundBoundary>;
  }
  if (segment.error) {
    wrapped = <FurinErrorBoundary fallback={segment.error}>{wrapped}</FurinErrorBoundary>;
  }
  return wrapped;
}

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute
): ReactNode {
  const Component = route.page.component;
  let element: ReactNode = <Component {...data} />;

  // Index segmentBoundaries by depth for O(1) lookup during the wrap loop.
  // Directory depth `d` maps 1:1 to routeChain[d] in Furin's model (routeChain
  // is ordered shallow→deep, with index 0 being the root).
  const byDepth = new Map<number, SegmentBoundary>();
  // Defensive fallback: some legacy callers / tests construct a ResolvedRoute
  // without the segmentBoundaries field.
  for (const segment of route.segmentBoundaries ?? []) {
    byDepth.set(segment.depth, segment);
  }

  // Build inside-out. At each level we first wrap the accumulated subtree
  // with the boundary declared at this depth (so the boundary sits INSIDE
  // the layout at the same depth), THEN wrap with the layout itself.
  for (let i = route.routeChain.length - 1; i >= 1; i--) {
    element = wrapInBoundaries(element, byDepth.get(i));
    const routeEntry = route.routeChain[i];
    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  // Depth 0 = pagesDir itself = the root layout directory. Boundary wraps
  // everything below the root layout; root layout wraps the boundary.
  element = wrapInBoundaries(element, byDepth.get(0));

  if (rootLayout.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}

const DefaultNotFoundComponent: NotFoundComponent = ({ error }) => (
  <DefaultNotFoundScreen message={error.message} />
);

export function buildNotFoundElement(
  component: NotFoundComponent | undefined,
  error: FurinNotFoundError
): ReactNode {
  const NotFound = component ?? DefaultNotFoundComponent;
  return <NotFound error={{ message: error.message, data: error.data }} />;
}

const DefaultErrorComponent: ErrorComponent = ({ error, reset }) => (
  <DefaultErrorScreen digest={error.digest} message={error.message} reset={reset} />
);

function errorMessageOf(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "";
}

const SERVER_RESET_NOOP = () => {
  /* reset is a client-only action; the response is already committed here */
};

export function buildErrorElement(
  component: ErrorComponent | undefined,
  error: unknown,
  digest: string
): ReactNode {
  const ErrorView = component ?? DefaultErrorComponent;
  return <ErrorView error={{ message: errorMessageOf(error), digest }} reset={SERVER_RESET_NOOP} />;
}
