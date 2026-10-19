import { useRouterStore, useTypedNavigation } from "./context.ts";
import type { Navigate } from "./types.ts";

export type { Navigate, NavigateInput } from "./types.ts";

/** Reads only the stable router, so callers do not re-render on navigation. */
export function useNavigate(): Navigate {
  return useTypedNavigation(useRouterStore().router).navigate;
}
