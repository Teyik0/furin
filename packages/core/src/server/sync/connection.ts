import type { Context } from "elysia";
import { log } from "evlog";
import type { FurinSyncOptions, SyncConnectionLease } from "./config.ts";

// A function on a Request never crosses HTTP; Symbol.for also works across published bundles.
export const LOCAL_SYNC_CONNECTION = Symbol.for("furin.sync.local-connection.v1");
export interface LocalSyncRequest extends Request {
  [LOCAL_SYNC_CONNECTION]?: (context: Context, sync: FurinSyncOptions) => Promise<void>;
}

/** Principal resolvers reject signed-out requests by throwing or returning an empty identity. */
export async function verifiedSyncPrincipal(
  sync: FurinSyncOptions,
  context: Context
): Promise<string | undefined> {
  try {
    const principal = await sync.principal(context);
    return principal.length > 0 ? principal : undefined;
  } catch {
    return undefined;
  }
}

function releaseLease(lease: SyncConnectionLease | undefined): void {
  try {
    lease?.release();
  } catch (error) {
    log.warn({ action: "sync_connection_release_failed", error: String(error) });
  }
}

/** Acquire asynchronously while allowing the transport to close before acquisition finishes. */
export function createSyncConnectionLifetime(
  sync: FurinSyncOptions,
  context: Context,
  changed: () => void
) {
  let closed = false;
  let lease: SyncConnectionLease | undefined;
  const onAbort = () => {
    if (!closed) {
      changed();
    }
  };
  return {
    async acquire(): Promise<void> {
      if (closed) {
        return;
      }
      const acquired = await sync.connection?.(context);
      if (closed) {
        releaseLease(acquired);
        return;
      }
      lease = acquired;
      lease?.signal.addEventListener("abort", onAbort, { once: true });
      if (lease?.signal.aborted) {
        onAbort();
      }
    },
    close(): void {
      if (closed) {
        return;
      }
      closed = true;
      lease?.signal.removeEventListener("abort", onAbort);
      releaseLease(lease);
      lease = undefined;
    },
  };
}
