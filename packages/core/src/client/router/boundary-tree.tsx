import type React from "react";
import { FurinErrorBoundary } from "../boundaries.tsx";
import { RouterContext } from "./context.ts";
import type { RootBoundaryOptions, RouterContextValue } from "./types.ts";

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
