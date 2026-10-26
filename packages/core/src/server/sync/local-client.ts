import type { AnyElysia } from "elysia";
import {
  createSyncClientRuntime,
  type SyncClient,
  SyncClientError,
  type SyncClientOptions,
} from "../../client/sync-client.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { FurinSyncOptions } from "./config.ts";
import {
  createSyncConnectionLifetime,
  LOCAL_SYNC_CONNECTION,
  type LocalSyncRequest,
} from "./connection.ts";
import { subscribeSyncCursor } from "./stream.ts";

export interface LocalSyncClientOptions
  extends Pick<SyncClientOptions, "headers" | "fetch" | "syncPath"> {
  app: Pick<AnyElysia, "handle">;
  sync: FurinSyncOptions;
}

/** Follow treaty(app) queries through the application's own authorized handlers. */
export function createLocalSyncClient(options: LocalSyncClientOptions): SyncClient {
  // Eden uses this synthetic origin for treaty(app); it never leaves app.handle().
  const changesUrl = new URL(
    `${options.syncPath ?? options.sync.path ?? "/_furin/sync"}/changes`,
    "http://e.ly"
  );
  return createSyncClientRuntime(options, {
    accepts: (reference) => reference.application === options.app,
    fetchChanges: (after, headers, signal) => {
      const url = new URL(changesUrl);
      url.searchParams.set("after", after ?? "0");
      return options.app.handle(new Request(url, { ...options.fetch, headers, signal }));
    },
    subscribe: async ({ headers, signal, onCursor, onContextChange }) => {
      let access: ReturnType<typeof createSyncConnectionLifetime> | undefined;
      let unsubscribe: (() => void) | undefined;
      const stop = () => {
        signal.removeEventListener("abort", stop);
        access?.close();
        unsubscribe?.();
      };
      signal.addEventListener("abort", stop, { once: true });
      const request = new Request(changesUrl, {
        ...options.fetch,
        headers,
        signal,
      }) as LocalSyncRequest;
      request[LOCAL_SYNC_CONNECTION] = async (context, sync) => {
        access = createSyncConnectionLifetime(sync, context, onContextChange);
        await access.acquire();
        if (signal.aborted) {
          return;
        }
        const subscription = await subscribeSyncCursor(sync, IS_DEV, onCursor);
        if (signal.aborted) {
          subscription.unsubscribe();
        } else {
          ({ unsubscribe } = subscription);
        }
      };
      try {
        signal.throwIfAborted();
        const response = await options.app.handle(request);
        signal.throwIfAborted();
        if (!response.ok) {
          throw new SyncClientError("Local sync connection refused", response.status);
        }
        if (!access) {
          throw new SyncClientError(
            "Local sync endpoint does not support event connections",
            undefined
          );
        }
        return stop;
      } catch (error) {
        stop();
        throw error;
      }
    },
  });
}
