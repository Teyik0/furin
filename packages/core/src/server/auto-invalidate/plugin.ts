import { type Context, Elysia } from "elysia";
import {
  appendPendingInvalidationHeader,
  isSuccessfulMutationResponse,
  runInvalidationRules,
} from "./runtime.ts";
import type { InvalidationInput } from "./types.ts";

type AnyAfterHandleContext = Pick<Context, "set"> & {
  response?: unknown;
  responseValue?: unknown;
};

export function furinInvalidate() {
  return new Elysia({ name: "furin-invalidate" }).macro({
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
