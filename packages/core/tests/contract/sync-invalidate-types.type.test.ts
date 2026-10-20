// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { test } from "bun:test";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import type { SyncRuntimeOptions } from "../../src/server/sync/index.ts";
import { furinSync } from "../../src/server/sync/plugin.ts";

function typedSyncApp(options: SyncRuntimeOptions) {
  return new Elysia()
    .use(furinSync(options))
    .get(
      "/boards/:boardId",
      {
        query: t.Object({ page: t.Number() }),
        sync: {
          id: "typed.board",
          scope: ({ params, query }) => {
            expectTypeOf(params).toEqualTypeOf<{ boardId: string }>();
            expectTypeOf(query).toEqualTypeOf<{ page: number }>();
            return { boardId: params.boardId };
          },
        },
      },
      () => ({ ok: true })
    )
    .post(
      "/boards/:boardId/cards",
      {
        body: t.Object({ title: t.String() }),
        sync: {
          invalidate: ({ params, body }) => {
            expectTypeOf(params).toEqualTypeOf<{ boardId: string }>();
            expectTypeOf(body).toEqualTypeOf<{ title: string }>();
            return { id: "typed.board", scope: { boardId: params.boardId } };
          },
        },
      },
      ({ invalidate }) => {
        invalidate({ id: "typed.board", scope: { boardId: "alpha" } });
        invalidate([
          { id: "typed.boards", scope: {} },
          { path: "/boards", type: "page" },
        ]);
        // @ts-expect-error unknown query ID
        invalidate({ id: "typed.borad", scope: { boardId: "alpha" } });
        // @ts-expect-error scopes keep their declared fields
        invalidate({ id: "typed.board", scope: { tenant: "alpha" } });
        // @ts-expect-error scope values keep their declared types
        invalidate({ id: "typed.board", scope: { boardId: 1 } });
        return { ok: true };
      }
    )
    .patch(
      "/boards/:boardId",
      {
        sync: {
          // @ts-expect-error selectors no longer receive the handler result
          invalidate: ({ responseValue }) => ({ tags: [String(responseValue)] }),
        },
      },
      () => ({ ok: true })
    )
    .put("/static", { sync: { invalidate: { tags: ["static"] } } }, () => ({ ok: true }))
    .put("/rule", { sync: { path: "/rule", type: "page" } }, () => ({ ok: true }))
    .delete("/off", { sync: false }, () => ({ ok: true }))
    .guard(
      {
        params: t.Object({ id: t.String() }),
        sync: {
          invalidate: ({ params }) => {
            expectTypeOf(params).toEqualTypeOf<{ id: string }>();
            return { id: "typed.board", scope: { boardId: params.id } };
          },
        },
      },
      (app) => app.delete("/cards/:id", () => ({ ok: true }))
    );
}

test("sync route options see the route's params, query and body", () => {
  expectTypeOf(typedSyncApp).toBeFunction();
});
