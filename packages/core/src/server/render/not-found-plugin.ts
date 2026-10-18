import { type AnyElysia, Elysia, NotFound } from "elysia";
import type { FurinNativeRouteContext } from "../../define-route.ts";
import type { FurinInstance } from "../instance.ts";
import { renderNotFound } from "../router/dispatch.ts";

/**
 * Routes unmatched requests to the runtime's single not-found path
 * (`renderNotFound`), identical in development and production, for documents
 * and navigation data requests alike. Only the entry point depends on the
 * mount position:
 *
 * - ROOT instance (`prefix === ""`): a global `NotFound` handler owns the root
 *   scope, and a parent `.onError()` registered BEFORE `.use(furin)` still
 *   wins (documented escape hatch for JSON API 404s).
 * - PREFIXED instance: a global hook would leak onto sibling apps, and a
 *   local one never sees unmatched paths (they belong to no route). Instead
 *   the instance registers a lowest-priority catch-all under its own prefix;
 *   the router prefers every more-specific route, so this only fires for
 *   paths no page matched.
 */
export function createNotFoundHandling(instance: FurinInstance): AnyElysia {
  const app = new Elysia();
  if (instance.prefix === "") {
    return app.onError("global", NotFound, (context) =>
      renderNotFound(instance, context as unknown as FurinNativeRouteContext)
    );
  }
  return app.get("/*", (context) =>
    renderNotFound(instance, context as unknown as FurinNativeRouteContext)
  );
}
