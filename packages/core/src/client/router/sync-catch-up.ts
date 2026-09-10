// biome-ignore-all lint/performance/noAwaitInLoops: sync catch-up pages must be fetched sequentially by cursor
export interface SyncChangePayload {
  cursor: string;
  invalidations: readonly string[];
}

export interface SyncChangePagePayload {
  changes: readonly SyncChangePayload[];
  cursor: string;
  hasMore: boolean;
  reset: boolean;
}

interface SyncCatchUpOptions {
  fetchPage: (after: string | undefined) => Promise<SyncChangePagePayload>;
  onInvalidations: (invalidations: readonly string[]) => void;
}

export interface SyncCatchUp {
  catchUp: () => Promise<void>;
  cursor: () => string | undefined;
}

interface InvalidationRefreshOptions {
  onError: (error: unknown) => void;
  refresh: () => Promise<void>;
}

export interface InvalidationRefresh {
  run: () => Promise<void>;
}

export function createInvalidationRefresh(
  options: InvalidationRefreshOptions
): InvalidationRefresh {
  let running: Promise<void> | undefined;
  let requested = false;

  const refreshUntilCurrent = async (): Promise<void> => {
    do {
      requested = false;
      try {
        await options.refresh();
      } catch (error) {
        if (!isAbortError(error)) {
          throw error;
        }
      }
    } while (requested);
  };

  return {
    run() {
      requested = true;
      if (!running) {
        running = refreshUntilCurrent()
          .catch((error: unknown) => {
            if (!isAbortError(error)) {
              options.onError(error);
            }
          })
          .finally(() => {
            running = undefined;
          });
      }
      return running;
    },
  };
}

export function createSyncCatchUp(options: SyncCatchUpOptions): SyncCatchUp {
  let currentCursor: string | undefined;
  let running: Promise<void> | undefined;
  let requested = false;

  const readUntilCurrent = async (): Promise<void> => {
    do {
      requested = false;
      let page: SyncChangePagePayload;
      do {
        page = await options.fetchPage(currentCursor ?? "0");
        if (page.reset) {
          options.onInvalidations(["/:layout"]);
          currentCursor = page.cursor;
          break;
        }
        for (const change of page.changes) {
          options.onInvalidations(change.invalidations);
        }
        currentCursor = page.cursor;
      } while (page.hasMore);
    } while (requested);
  };

  return {
    catchUp() {
      requested = true;
      if (!running) {
        running = readUntilCurrent().finally(() => {
          running = undefined;
        });
      }
      return running;
    },
    cursor: () => currentCursor,
  };
}

import { isAbortError } from "./abort.ts";
