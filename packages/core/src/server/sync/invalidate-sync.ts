import { type QueryScope, queryTag } from "../../shared/sync-query.ts";
import { runInvalidationRules } from "../auto-invalidate/runtime.ts";
import type { InvalidationRule } from "../auto-invalidate/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";
import { normalizedInvalidations } from "./atomic.ts";
import type { SyncParams, SyncPattern } from "./queries.ts";
import { publishCursor, resolveSyncRuntime } from "./runtime.ts";

export interface SyncInvalidationOptions {
  /** Verified identity selected by trusted server code, never an untrusted request field. */
  principal: string;
}

/**
 * Invalidates outside a request (cron, webhook) what the handler's `invalidate()` takes — a GET
 * pattern and its params, cache tags or a page path: purges the pages built from it, then
 * journals and broadcasts it through the runtime `sync` configures, as a mutation would.
 */
export function invalidateSync<Target extends SyncPattern>(
  sync: SyncRuntimeOptions,
  pattern: Target,
  params?: NoInfer<SyncParams<Target>>,
  options?: SyncInvalidationOptions
): Promise<void>;
export function invalidateSync(
  sync: SyncRuntimeOptions,
  rule: InvalidationRule,
  options?: SyncInvalidationOptions
): Promise<void>;
export async function invalidateSync(
  sync: SyncRuntimeOptions,
  target: string | InvalidationRule,
  paramsOrOptions?: QueryScope | SyncInvalidationOptions,
  options?: SyncInvalidationOptions
): Promise<void> {
  const provenance =
    typeof target === "string" ? options : (paramsOrOptions as SyncInvalidationOptions | undefined);
  if (provenance?.principal === "") {
    throw new Error("[furin] Sync invalidation principal must not be empty.");
  }
  const runtime = resolveSyncRuntime(sync, IS_DEV);
  const rule =
    typeof target === "string"
      ? {
          tags: [
            queryTag({ id: target, scope: (paramsOrOptions as QueryScope | undefined) ?? {} }),
          ],
        }
      : target;
  await runInvalidationRules(rule);
  publishCursor(
    runtime,
    await runtime.adapter.appendInvalidations(normalizedInvalidations(rule), provenance?.principal)
  );
}
