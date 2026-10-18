import { Elysia } from "elysia";
import { ensureRequestScope } from "../instance.ts";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "./runtime.ts";
import type { InvalidationInput } from "./types.ts";

type AnyAfterHandleContext = Parameters<typeof isSuccessfulMutationResponse>[0];

export function furinInvalidate() {
  return new Elysia({ name: "furin-invalidate" })
    .wrap(
      (fetch) =>
        (request, ...rest) =>
          ensureRequestScope(() => fetch(request, ...rest))
    )
    .macro({
      invalidate(rules: InvalidationInput) {
        return {
          async afterHandle(ctx: AnyAfterHandleContext) {
            if (!isSuccessfulMutationResponse(ctx)) {
              return;
            }
            await runInvalidationRules(rules);
            appendPendingInvalidationHeader(ctx.set);
          },
        };
      },
    });
}
