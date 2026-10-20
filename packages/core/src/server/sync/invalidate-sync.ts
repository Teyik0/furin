import { queryTag } from "../../shared/sync-query.ts";
import { runInvalidationRules } from "../auto-invalidate/runtime.ts";
import { IS_DEV } from "../runtime-env.ts";
import type { SyncRuntimeOptions } from "./adapter.ts";
import type { SyncParams, SyncPattern } from "./queries.ts";
import { publishCursor, resolveSyncRuntime } from "./runtime.ts";

/**
 * Invalidates a GET URL outside a request (cron, webhook): purges the pages built from it,
 * then journals and broadcasts it through the runtime `sync` configures, as a mutation would.
 */
export async function invalidateSync<Target extends SyncPattern>(
  sync: SyncRuntimeOptions,
  pattern: Target,
  params?: NoInfer<SyncParams<Target>>
): Promise<void> {
  const runtime = resolveSyncRuntime(sync, IS_DEV);
  const tags = [queryTag({ id: pattern, scope: params ?? {} })];
  await runInvalidationRules({ tags });
  publishCursor(runtime, await runtime.adapter.appendInvalidations([{ kind: "tags", tags }]));
}
