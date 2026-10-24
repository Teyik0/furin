import type { AnyElysia } from "elysia";
import {
  createSyncClientRuntime,
  type SyncClient,
  type SyncClientOptions,
} from "../../client/sync-client.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { FurinSyncOptions } from "./config.ts";
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
    subscribe: async ({ onCursor }) => {
      const subscription = await subscribeSyncCursor(options.sync, IS_DEV, onCursor);
      return subscription.unsubscribe;
    },
  });
}
