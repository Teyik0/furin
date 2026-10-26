import { inAotBuild } from "elysia";
import type { SyncAdapter, SyncNotifier, SyncRuntimeOptions } from "./adapter.ts";
import { PollingSyncNotifier } from "./notifier.ts";
import { configurePrincipalSecret } from "./principal-journal.ts";

const POLL_INTERVAL_MS = 250;
const pollingNotifiers = new WeakMap<object, PollingSyncNotifier>();
const factoryAdapters = new WeakMap<SyncRuntimeOptions, SyncAdapter>();
const runtimes = new WeakMap<SyncRuntimeOptions, Map<boolean, ResolvedSyncRuntime>>();

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

/** Prepare resources before listening; AOT only installs the same route behaviors. */
export function prepareSyncRuntime(options: SyncRuntimeOptions, development: boolean): void {
  if (inAotBuild()) {
    return;
  }
  if (typeof options.adapter === "function" && !factoryAdapters.has(options)) {
    const adapter = options.adapter();
    if (adapter instanceof Promise) {
      throw new Error("[furin] Sync adapter factories must return an adapter synchronously.");
    }
    factoryAdapters.set(options, adapter);
  }
  resolveSyncRuntime(options, development);
}

/** Reads a prepared factory adapter; request paths never invoke the factory. */
export function resolveSyncRuntime(
  options: SyncRuntimeOptions,
  development: boolean
): ResolvedSyncRuntime {
  if (inAotBuild()) {
    throw new Error("[furin] Sync runtime is unavailable during AOT compilation.");
  }
  const existingRuntime = runtimes.get(options)?.get(development);
  if (existingRuntime) {
    return existingRuntime;
  }
  const adapter =
    typeof options.adapter === "function" ? factoryAdapters.get(options) : options.adapter;
  if (!adapter) {
    throw new Error(
      "[furin] Compose furinSync(sync) or furin({ sync }) before using a Sync adapter factory."
    );
  }
  if (!development && adapter.scope === "process-local") {
    throw new Error("[furin] Production sync cannot use a process-local SyncAdapter.");
  }
  configurePrincipalSecret(adapter, options.secret, development);
  if (
    options.notifier &&
    adapter.notificationChannel !== undefined &&
    options.notifier.notificationChannel !== undefined &&
    adapter.notificationChannel !== options.notifier.notificationChannel
  ) {
    throw new Error("[furin] SyncAdapter and SyncNotifier notification channels do not match.");
  }
  if (!(options.notifier || development) && adapter.scope === "distributed") {
    throw new Error(
      "[furin] Distributed production sync requires an explicit SyncNotifier. Configure the adapter notifier or pass PollingSyncNotifier as a compatibility fallback."
    );
  }
  let notifier = options.notifier ?? pollingNotifiers.get(adapter);
  if (!notifier) {
    const polling = new PollingSyncNotifier(adapter, POLL_INTERVAL_MS);
    pollingNotifiers.set(adapter, polling);
    notifier = polling;
  }
  const runtime = { adapter, development, notifier };
  let modes = runtimes.get(options);
  if (!modes) {
    modes = new Map();
    runtimes.set(options, modes);
  }
  modes.set(development, runtime);
  return runtime;
}
