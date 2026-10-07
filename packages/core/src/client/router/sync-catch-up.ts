// biome-ignore-all lint/performance/noAwaitInLoops: sync catch-up pages must be fetched sequentially by cursor
import type { SyncInvalidation } from "../../server/sync/adapter.ts";
import { encodeInvalidationEntry } from "../../shared/invalidation-header.ts";
import { type QueryIdentity, queryFromTag } from "../../shared/sync-query.ts";

export interface SyncChangePayload {
  cursor: string;
  invalidations: readonly (string | SyncInvalidation)[];
  queries?: readonly import("../../shared/sync-query.ts").QueryIdentity[];
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
  onQueries?: (identities: readonly import("../../shared/sync-query.ts").QueryIdentity[]) => void;
  onReset?: () => void;
}

function changeInvalidations(change: SyncChangePayload): {
  paths: string[];
  queries: QueryIdentity[];
} {
  const paths: string[] = [];
  const queries = [...(change.queries ?? [])];
  for (const entry of change.invalidations) {
    if (typeof entry === "string") {
      paths.push(entry);
    } else if (entry.kind === "path") {
      paths.push(encodeInvalidationEntry(entry.path, entry.type));
    } else {
      for (const tag of entry.tags) {
        const identity = queryFromTag(tag);
        if (identity) {
          queries.push(identity);
        } else {
          paths.push("/:layout");
        }
      }
    }
  }
  return { paths, queries };
}

export interface SyncCatchUp {
  catchUp: () => Promise<void>;
  cursor: () => string | undefined;
  seed: (cursor: string) => void;
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
          options.onReset?.();
          options.onInvalidations(["/:layout"]);
          currentCursor = page.cursor;
          break;
        }
        for (const change of page.changes) {
          const { paths, queries } = changeInvalidations(change);
          options.onInvalidations(paths);
          if (queries.length > 0) {
            options.onQueries?.(queries);
          }
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
    seed(cursor) {
      currentCursor ??= cursor;
    },
  };
}

import { isAbortError } from "./abort.ts";
