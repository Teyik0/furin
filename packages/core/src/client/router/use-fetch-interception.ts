import { useEffect } from "react";
import type { InvalidationRefresh } from "../sync-catch-up.ts";
import { observeWindowFetch } from "./fetch-observers.ts";
import {
  applyRevalidateHeader,
  isSameOriginFetchResult,
  normalizeHref,
  shouldAutoRefreshPath,
  toLogical,
} from "./link-utils.ts";
import { SYNC_REQUEST } from "./optimistic.ts";

/**
 * Processes `X-Furin-Revalidate` headers on every same-origin `window.fetch`
 * response: evicts the named pages and refreshes the current one when
 * `autoRefresh` is on.
 */
export function useFetchInterception(options: {
  autoRefresh: boolean;
  basePath: string;
  invalidatePath: (path: string, type: "page" | "layout") => void;
  invalidationRefresh: InvalidationRefresh;
}): void {
  const { autoRefresh, basePath, invalidatePath, invalidationRefresh } = options;
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    return observeWindowFetch((args, response) => {
      if (args[1] && SYNC_REQUEST in args[1]) {
        return;
      }
      if (!isSameOriginFetchResult(args[0], response.url, window.location.origin)) {
        return;
      }
      const invalidated: Array<{ path: string; type: "page" | "layout" }> = [];
      applyRevalidateHeader(response.headers, (path, type) => {
        const resolvedType = type ?? "page";
        invalidatePath(path, resolvedType);
        invalidated.push({ path, type: resolvedType });
      });
      if (autoRefresh && invalidated.length > 0) {
        const currentLogicalPath =
          normalizeHref(toLogical(window.location.pathname, basePath)) + window.location.search;
        if (shouldAutoRefreshPath(currentLogicalPath, invalidated)) {
          // fire-and-forget: don't block the original fetch caller
          invalidationRefresh.run();
        }
      }
    });
  }, [invalidatePath, invalidationRefresh, autoRefresh, basePath]);
}
