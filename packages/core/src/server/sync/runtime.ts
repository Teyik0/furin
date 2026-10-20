import type { SyncAdapter, SyncNotifier, SyncRuntimeOptions } from "./adapter.ts";
import { PollingSyncNotifier } from "./notifier.ts";
import { configurePrincipalSecret } from "./principal-journal.ts";

const POLL_INTERVAL_MS = 250;
const pollingNotifiers = new WeakMap<object, PollingSyncNotifier>();

export interface ResolvedSyncRuntime {
  adapter: SyncAdapter;
  /** Mode of the runtime serving this sync configuration. */
  development: boolean;
  notifier: SyncNotifier;
}

/** Wakes subscribers, unless the adapter's commit already notified the notifier's channel. */
export function publishCursor(runtime: ResolvedSyncRuntime, cursor: string): void {
  const alreadyPublished =
    runtime.adapter.publishesNotifications !== false &&
    runtime.adapter.notificationChannel !== undefined &&
    runtime.adapter.notificationChannel === runtime.notifier.notificationChannel;
  if (!alreadyPublished) {
    runtime.notifier.publish(cursor).catch(() => undefined);
  }
}

export function resolveSyncRuntime(
  options: SyncRuntimeOptions,
  development: boolean
): ResolvedSyncRuntime {
  if (!development && options.adapter.scope === "process-local") {
    throw new Error("[furin] Production sync cannot use a process-local SyncAdapter.");
  }
  configurePrincipalSecret(options.adapter, options.secret, development);
  if (options.notifier) {
    if (
      options.adapter.notificationChannel !== undefined &&
      options.notifier.notificationChannel !== undefined &&
      options.adapter.notificationChannel !== options.notifier.notificationChannel
    ) {
      throw new Error("[furin] SyncAdapter and SyncNotifier notification channels do not match.");
    }
    return { adapter: options.adapter, development, notifier: options.notifier };
  }
  if (!development && options.adapter.scope === "distributed") {
    throw new Error(
      "[furin] Distributed production sync requires an explicit SyncNotifier. Configure the adapter notifier or pass PollingSyncNotifier as a compatibility fallback."
    );
  }
  const existing = pollingNotifiers.get(options.adapter);
  if (existing) {
    return { adapter: options.adapter, development, notifier: existing };
  }
  const notifier = new PollingSyncNotifier(options.adapter, POLL_INTERVAL_MS);
  pollingNotifiers.set(options.adapter, notifier);
  return { adapter: options.adapter, development, notifier };
}
