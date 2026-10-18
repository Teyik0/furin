import { Elysia, NotFound } from "elysia";
import type { FurinRouteDispatcher } from "../../define-route.ts";
import { dispatchNativeRoute } from "../router/dispatch.ts";
import { renderRootNotFound } from "./not-found.ts";

/**
 * 404 handling per mount position:
 *
 * - ROOT instance (`prefix === ""`): a global `NotFound` handler owns the root
 *   scope, and a parent `.onError()`
 *   registered BEFORE `.use(furin)` still wins (documented escape hatch for
 *   JSON API 404s).
 * - PREFIXED instance: a global hook would leak onto sibling apps, and a
 *   local one never sees unmatched paths (they belong to no route). Instead
 *   the instance registers a lowest-priority catch-all under its own prefix;
 *   the router prefers every more-specific route, so this only fires for
 *   paths no page matched. Skipped when the app defines its own `[...rest]`
 *   catch-all page.
 */
export function createNotFoundHandling(
  prefix: string,
  routes: Array<{ pattern: string }>,
  root: Parameters<typeof renderRootNotFound>[0],
  tryNativeDispatch: ((context: { request: Request }) => Promise<unknown>) | undefined
): Elysia {
  const app = new Elysia();
  const dispatch =
    tryNativeDispatch ??
    (routes.some((route) => route.pattern === "/*")
      ? async (context: { request: Request }): Promise<unknown> => {
          if (context.request.method !== "GET") {
            return;
          }
          return await dispatchNativeRoute(context as Parameters<FurinRouteDispatcher>[0]);
        }
      : undefined);
  if (prefix === "") {
    app.onError("global", NotFound, async (context) => {
      // Dev topology: the native renderer is rebuilt by the watcher on route
      // add/remove, so a hot-added route (no mounted Elysia route yet) can
      // still be served here. Production also renders root catch-all pages here.
      if (dispatch) {
        const rendered = await dispatch(context);
        if (rendered !== undefined && rendered !== null) {
          return rendered;
        }
      }
      return await renderRootNotFound(root, context.request, context.server?.url.origin);
    });
    return app;
  }
  app.get("/*", async (context) => {
    if (dispatch) {
      const rendered = await dispatch(context);
      if (rendered !== undefined && rendered !== null) {
        return rendered;
      }
    }
    return renderRootNotFound(root, context.request, context.server?.url.origin);
  });
  return app;
}
