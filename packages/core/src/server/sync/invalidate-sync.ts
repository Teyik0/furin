import { type QueryScope, queryTag } from "../../shared/sync-query.ts";
import { runInvalidationRules } from "../auto-invalidate/runtime.ts";
import type { InvalidationRule } from "../auto-invalidate/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";
import { normalizedInvalidations } from "./atomic.ts";
import type { SyncParams, SyncPattern } from "./queries.ts";
import { publishCursor, resolveSyncRuntime } from "./runtime.ts";

/**
 * Invalidates outside a request (cron, webhook) what the handler's `invalidate()` takes — a GET
 * pattern and its params, cache tags or a page path: purges the pages built from it, then
 * journals and broadcasts it through the runtime `sync` configures, as a mutation would.
 */
export function invalidateSync<Target extends SyncPattern>(
  sync: SyncRuntimeOptions,
  pattern: Target,
  params?: NoInfer<SyncParams<Target>>
): Promise<void>;
export function invalidateSync(sync: SyncRuntimeOptions, rule: InvalidationRule): Promise<void>;
export async function invalidateSync(
  sync: SyncRuntimeOptions,
  target: string | InvalidationRule,
  params?: QueryScope
): Promise<void> {
  const runtime = resolveSyncRuntime(sync, IS_DEV);
  const rule =
    typeof target === "string" ? { tags: [queryTag({ id: target, scope: params ?? {} })] } : target;
  await runInvalidationRules(rule);
  publishCursor(runtime, await runtime.adapter.appendInvalidations(normalizedInvalidations(rule)));
}
