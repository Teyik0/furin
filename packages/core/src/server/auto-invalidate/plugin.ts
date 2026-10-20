import { Elysia } from "elysia";
import { ensureRequestScope } from "../instance.ts";
import { isSyncRequest } from "../sync/plugin.ts";
import {
  appendQueryInvalidations,
  isMutationMethod,
  requestInvalidate,
  resolveSyncInvalidations,
} from "../sync/queries.ts";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "./runtime.ts";

type AfterHandleContext = Parameters<typeof isSuccessfulMutationResponse>[0] &
  Parameters<typeof resolveSyncInvalidations>[0];

const ownedRequests = new WeakSet<Request>();

/**
 * The handler's `invalidate()` without Furin Sync: a successful mutation purges the server
 * caches built from its targets and reports them to its caller only; nothing is journaled.
 */
export function furinInvalidate() {
  const plugin = new Elysia({ name: "furin-invalidate" })
    .wrap(
      (fetch) =>
        (request, ...rest) =>
          ensureRequestScope(() => fetch(request, ...rest))
    )
    .derive("global", ({ request }) => ({ invalidate: requestInvalidate(request) }))
    .onAfterHandle("global", async (ctx: AfterHandleContext) => {
      if (
        !ownedRequests.has(ctx.request) ||
        isSyncRequest(ctx.request) ||
        !isMutationMethod(ctx.request.method) ||
        !isSuccessfulMutationResponse(ctx)
      ) {
        return;
      }
      const rules = resolveSyncInvalidations(ctx);
      appendQueryInvalidations(rules, ctx);
      await runInvalidationRules(rules);
      appendPendingInvalidationHeader(ctx.set);
    });
  return (app: Elysia) =>
    app
      .onTransform(({ request }) => {
        ownedRequests.add(request);
      })
      .use(plugin);
}
