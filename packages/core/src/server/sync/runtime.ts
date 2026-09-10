import { IS_DEV } from "../runtime-env.ts";
import type { SyncAdapter, SyncNotifier, SyncRuntimeOptions } from "./adapter.ts";
import { PollingSyncNotifier } from "./notifier.ts";

const POLL_INTERVAL_MS = 250;
const pollingNotifiers = new WeakMap<object, PollingSyncNotifier>();

export interface ResolvedSyncRuntime {
  adapter: SyncAdapter;
  notifier: SyncNotifier;
}

export function resolveSyncRuntime(options: SyncRuntimeOptions): ResolvedSyncRuntime {
  if (!IS_DEV && options.adapter.scope === "process-local") {
    throw new Error("[furin] Production sync cannot use a process-local SyncAdapter.");
  }
  if (options.notifier) {
    if (
      options.adapter.notificationChannel !== undefined &&
      options.notifier.notificationChannel !== undefined &&
      options.adapter.notificationChannel !== options.notifier.notificationChannel
    ) {
      throw new Error("[furin] SyncAdapter and SyncNotifier notification channels do not match.");
    }
    return { adapter: options.adapter, notifier: options.notifier };
  }
  if (!IS_DEV && options.adapter.scope === "distributed") {
    throw new Error(
      "[furin] Distributed production sync requires an explicit SyncNotifier. Configure the adapter notifier or pass PollingSyncNotifier as a compatibility fallback."
    );
  }
  const existing = pollingNotifiers.get(options.adapter);
  if (existing) {
    return { adapter: options.adapter, notifier: existing };
  }
  const notifier = new PollingSyncNotifier(options.adapter, POLL_INTERVAL_MS);
  pollingNotifiers.set(options.adapter, notifier);
  return { adapter: options.adapter, notifier };
}
