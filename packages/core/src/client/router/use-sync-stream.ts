import { log } from "evlog";
import { useEffect } from "react";
import type { BrowserEventFor } from "../../shared/browser-events.ts";
import { queryTag, queryTags } from "../../shared/sync-query.ts";
import { setBrowserSyncAuthentication, subscribeBrowserEvent } from "../browser-events.ts";
import type { QueryStore } from "../query-store.ts";
import {
  createSyncCatchUp,
  type InvalidationRefresh,
  type SyncChangePagePayload,
} from "../sync-catch-up.ts";
import {
  applyRevalidateEntries,
  normalizeHref,
  shouldAutoRefreshPath,
  toLogical,
} from "./link-utils.ts";
import type { NavigationController } from "./navigation-controller.ts";
import type { RouterState } from "./types.ts";

/**
 * Listens for sync cursor notifications and recovers the changes over HTTP,
 * invalidating cached pages and queries and refreshing the current page when
 * `autoRefresh` is on.
 */
export function useSyncStream(options: {
  autoRefresh: boolean;
  basePath: string;
  controller: NavigationController;
  invalidationRefresh: InvalidationRefresh;
  queries: QueryStore;
  syncPath: string | undefined;
}): void {
  const { autoRefresh, basePath, controller, invalidationRefresh, queries, syncPath } = options;
  // react-doctor-disable-next-line react-doctor/effect-needs-cleanup
  useEffect(() => {
    if (!syncPath || typeof window === "undefined") {
      return;
    }

    const changesUrl = syncPath.startsWith("/")
      ? `${basePath}${syncPath}`
      : `${basePath}/${syncPath}`;
    let unsubscribe: (() => void) | undefined;
    let disposed = false;
    let requestController = new AbortController();
    let contextChanged = false;
    let session: string | undefined;
    const clearContext = () => {
      contextChanged = true;
      queries.clear();
      controller.invalidateContext();
    };
    const observeSession = (response: Response) => {
      const identity = response.headers.get("x-furin-sync-session");
      if (identity === null) {
        return;
      }
      if (session !== undefined && identity !== session) {
        clearContext();
      }
      session = identity;
    };
    const applyInvalidations = (entries: readonly string[]) => {
      if (disposed) {
        return;
      }
      const invalidations: Array<{ path: string; type: "page" | "layout" }> = [];
      applyRevalidateEntries(entries, (path, type) => {
        const resolvedType = type ?? "page";
        controller.invalidatePath(path, resolvedType);
        invalidations.push({ path, type: resolvedType });
      });

      if (autoRefresh && invalidations.length > 0) {
        const currentLogicalPath =
          normalizeHref(toLogical(window.location.pathname, basePath)) + window.location.search;
        if (shouldAutoRefreshPath(currentLogicalPath, invalidations)) {
          invalidationRefresh.run();
        }
      }
    };
    const createRecovery = () =>
      createSyncCatchUp({
        fetchPage: async (after) => {
          const url = new URL(`${changesUrl}/changes`, window.location.origin);
          if (after !== undefined) {
            url.searchParams.set("after", after);
          }
          const { signal } = requestController;
          const response = await window.fetch(url, { signal });
          signal.throwIfAborted();
          if (response.status === 401 || response.status === 403) {
            clearContext();
            setBrowserSyncAuthentication(false);
          }
          if (!response.ok) {
            throw new Error(`Sync catch-up failed with status ${response.status}`);
          }
          const page = (await response.json()) as SyncChangePagePayload;
          signal.throwIfAborted();
          observeSession(response);
          return page;
        },
        onInvalidations: applyInvalidations,
        onReset: () => {
          if (!disposed) {
            queries.invalidateAll();
          }
        },
        onQueries: (identities) => {
          queries.invalidate(identities);
          const tags = new Set(identities.map(queryTag));
          const affected = (snapshot: RouterState) =>
            snapshot.querySeeds?.some((seed) =>
              queryTags(seed.identity).some((tag) => tags.has(tag))
            ) === true;
          controller.invalidateQueries(affected);
          if (autoRefresh && affected(controller.getSnapshot().state)) {
            invalidationRefresh.run();
          }
        },
      });
    let catchUp = createRecovery();
    const recover = () => {
      if (disposed) {
        return;
      }
      const current = catchUp;
      current
        .catchUp()
        .then(() => {
          if (!disposed && catchUp === current && contextChanged) {
            contextChanged = false;
            queries.invalidateAll();
            applyInvalidations(["/:layout"]);
          }
        })
        .catch((error: unknown) => {
          if (!disposed) {
            log.warn({ action: "sync_catch_up_failed", error: String(error) });
          }
        });
    };
    const onSync = (event: BrowserEventFor<"sync">) => {
      if (event.data.context === "changed") {
        requestController.abort();
        requestController = new AbortController();
        catchUp.close();
        catchUp = createRecovery();
        clearContext();
        recover();
        return;
      }
      if (typeof event.data.cursor !== "string") {
        log.warn({ action: "sync_invalid_event", event: "browser-events.sync" });
        return;
      }
      // Notifications do not prove the rendered snapshot includes earlier writes.
      // Recover from zero first; only successful HTTP recovery advances the cursor.
      recover();
    };
    const connect = () => {
      if (disposed || unsubscribe) {
        return;
      }
      unsubscribe = subscribeBrowserEvent("sync", onSync);
      if (!unsubscribe) {
        log.warn({ action: "sync_transport_unavailable" });
      }
    };

    connect();
    return () => {
      disposed = true;
      requestController.abort();
      catchUp.close();
      unsubscribe?.();
    };
  }, [syncPath, basePath, invalidationRefresh, autoRefresh, queries, controller]);
}
