import type { ReactNode } from "react";
import { wrapSegmentBoundaries } from "../../client/boundaries.tsx";
import { DefaultErrorFallback, DefaultNotFoundFallback } from "../../client/default-screens.tsx";
import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";
import type { ErrorComponent } from "../../shared/error.ts";
import type { FurinNotFoundError, NotFoundComponent } from "../../shared/not-found.ts";
import type { ResolvedRoute, SegmentBoundary } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";

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
  const legacyRoute = route as ResolvedRoute & {
    segmentBoundaries?: SegmentBoundary[];
  };
  for (const segment of legacyRoute.segmentBoundaries ?? []) {
    byDepth.set(segment.depth, segment);
  }

  // Build inside-out. At each level we first wrap the accumulated subtree
  // with the boundary declared at this depth (so the boundary sits INSIDE
  // the layout at the same depth), THEN wrap with the layout itself.
  for (let i = route.routeChain.length - 1; i >= 1; i -= 1) {
    element = wrapSegmentBoundaries(element, byDepth.get(i), undefined);
    const routeEntry = route.routeChain[i];
    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  // Depth 0 = pagesDir itself = the root layout directory. Boundary wraps
  // everything below the root layout; root layout wraps the boundary.
  element = wrapSegmentBoundaries(element, byDepth.get(0), undefined);

  if (rootLayout.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}

export function wrapRootLayout(
  element: ReactNode,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute
): ReactNode {
  if (!rootLayout.layout) {
    return element;
  }
  const RootLayoutComponent = rootLayout.layout;
  return <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
}

export function buildNotFoundElement(
  component: NotFoundComponent | undefined,
  error: FurinNotFoundError
): ReactNode {
  const NotFound = component ?? DefaultNotFoundFallback;
  return <NotFound error={{ data: error.data, message: error.message }} />;
}

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

const GENERIC_ERROR_MESSAGE = "An unexpected error occurred.";

/**
 * Builds the error element rendered when a loader (or the SSR shell) fails.
 *
 * @param component - User-declared `error.tsx` component, or `undefined` to
 *   fall back to the built-in `DefaultErrorScreen` with a generic message.
 * @param error - The original thrown value. Kept for `errorMessageOf` lookup
 *   when no explicit `messageOverride` is provided (e.g. shell-render errors).
 * @param digest - 10-hex-char digest correlating with server logs.
 * @param messageOverride - Pre-extracted public message. Set by the loader
 *   pipeline when the thrown value is a `Response` (whose body has already
 *   been consumed in `runLoaders`); pass `undefined` to derive the message
 *   from `error` via `errorMessageOf`.
 * @param status - HTTP status to surface in `ErrorProps.error.status`. The
 *   loader pipeline passes the thrown `Response.status` (default 500); the
 *   shell-error recovery path always passes 500.
 */
export function buildErrorElement(
  component: ErrorComponent | undefined,
  error: unknown,
  digest: string,
  messageOverride: string | undefined,
  status: number
): ReactNode {
  const ErrorView = component ?? DefaultErrorFallback;
  let message: string;
  if (component && IS_DEV) {
    message = messageOverride ?? errorMessageOf(error);
  } else if (component) {
    message = messageOverride ?? GENERIC_ERROR_MESSAGE;
  } else if (IS_DEV) {
    // No user error.tsx: in dev, surface the real error message so the
    // developer can see what actually broke instead of a generic placeholder.
    // Production stays generic to avoid leaking internals — the digest still
    // correlates the rendered page with the full server-side log entry.
    message = (messageOverride ?? errorMessageOf(error)) || GENERIC_ERROR_MESSAGE;
  } else {
    message = GENERIC_ERROR_MESSAGE;
  }
  return <ErrorView error={{ digest, message, status }} reset={SERVER_RESET_NOOP} />;
}
