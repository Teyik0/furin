import { createElement, type ElementType, type ReactNode } from "react";
import { wrapSegmentBoundaries } from "../../client/boundaries.tsx";
import { DefaultErrorFallback, DefaultNotFoundFallback } from "../../client/default-screens.tsx";
import type { RuntimeRoute } from "../../client/internal/runtime-types.ts";
import { withRouteSnapshot } from "../../client/route-api.tsx";
import type { ErrorComponent } from "../../shared/error.ts";
import type { FurinNotFoundError, NotFoundComponent } from "../../shared/not-found.ts";
import { pageKey } from "../../shared/page-key.ts";
import type { ResolvedRoute, SegmentBoundary } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute
): ReactNode {
  const Component = route.page.component;
  let element: ReactNode = createElement(Component, {
    ...data,
    key: pageKey(route.pattern, data, route.page._route.remountDeps),
  });

  // Directories without layouts share their enclosing layout's chain index.
  // Keep their boundaries in inside-out order instead of overwriting them.
  const byDepth = new Map<number, SegmentBoundary[]>();
  const legacyRoute = route as ResolvedRoute & {
    segmentBoundaries?: SegmentBoundary[];
  };
  for (const segment of legacyRoute.segmentBoundaries ?? []) {
    const boundaries = byDepth.get(segment.depth) ?? [];
    boundaries.unshift(segment);
    byDepth.set(segment.depth, boundaries);
  }

  // Build inside-out. At each level we first wrap the accumulated subtree
  // with the boundary declared at this depth (so the boundary sits INSIDE
  // the layout at the same depth), THEN wrap with the layout itself.
  for (let i = route.routeChain.length - 1; i >= 1; i -= 1) {
    for (const segment of byDepth.get(i) ?? []) {
      element = wrapSegmentBoundaries(element, segment, undefined);
    }
    const routeEntry = route.routeChain[i];
    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = createElement(Layout as ElementType, data, element);
    }
  }

  // Index-0 boundaries wrap everything below the root layout, including
  // pathless directories without their own layouts.
  for (const segment of byDepth.get(0) ?? []) {
    element = wrapSegmentBoundaries(element, segment, undefined);
  }

  if (rootLayout.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = createElement(RootLayoutComponent as ElementType, data, element);
  }

  return withRouteSnapshot(element, route.pattern, data);
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
  return createElement(RootLayoutComponent as ElementType, data, element);
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

export function errorMessageForRender(
  component: ErrorComponent | undefined,
  error: unknown,
  messageOverride: string | undefined
): string {
  if (component && IS_DEV) {
    return messageOverride ?? errorMessageOf(error);
  }
  if (component) {
    return messageOverride ?? GENERIC_ERROR_MESSAGE;
  }
  if (IS_DEV) {
    return (messageOverride ?? errorMessageOf(error)) || GENERIC_ERROR_MESSAGE;
  }
  return GENERIC_ERROR_MESSAGE;
}

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
  const message = errorMessageForRender(component, error, messageOverride);
  return <ErrorView error={{ digest, message, status }} reset={SERVER_RESET_NOOP} />;
}
