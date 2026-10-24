// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { test } from "bun:test";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { invalidateSync, type SyncRuntimeOptions } from "../../src/server/sync/index.ts";
import { furinSync } from "../../src/server/sync/plugin.ts";
import type { GetPatterns, Invalidate, SyncParams } from "../../src/server/sync/queries.ts";

const api = new Elysia({ prefix: "/api" })
  .get("/boards", () => [{ id: "b1" }])
  .get("/boards/:boardId", ({ params }) => ({ id: params.boardId }))
  .post("/boards/:boardId/cards", { body: t.Object({ title: t.String() }) }, ({ body }) => body)
  .get("/cards/:id", ({ params }) => ({ id: params.id }))
  .patch("/cards/:id", { body: t.Object({ title: t.String() }) }, ({ body }) => body);
type Patterns = GetPatterns<(typeof api)["~Routes"], "">;
declare const invalidate: Invalidate<Patterns>;

function assertInvalidate() {
  invalidate("/api/boards");
  invalidate("/api/boards/:boardId");
  invalidate("/api/boards/:boardId", { boardId: "b1" });
  invalidate("/api/cards/:id", { id: 1 });
  // @ts-expect-error unknown routes are rejected
  invalidate("/api/board/:boardId");
  // @ts-expect-error a route without a GET is no live query
  invalidate("/api/boards/:boardId/cards");
  // @ts-expect-error params keep the pattern's names
  invalidate("/api/boards/:boardId", { id: "b1" });
  // @ts-expect-error a static route has no params
  invalidate("/api/boards", { boardId: "b1" });
}

function syncRouteOptions(options: SyncRuntimeOptions) {
  return (
    new Elysia()
      .use(furinSync(options))
      .put("/rule", ({ invalidate: invalidateAny }) => {
        // Until an app is registered, any path and params are accepted.
        invalidateAny("/anything/:id", { id: 1 });
        invalidateAny({ path: "/rule", type: "page" });
        invalidateAny({ tags: ["rule"] });
        // @ts-expect-error a page target names its type
        invalidateAny({ path: "/rule" });
        return { ok: true };
      })
      .delete("/off", { idempotent: false }, () => ({ ok: true }))
      // @ts-expect-error only false opts a route out of idempotency
      .patch("/on", { idempotent: true }, () => ({ ok: true }))
      // @ts-expect-error invalidations are no route option: call invalidate()
      .post("/static", { sync: { tags: ["rule"] } }, () => ({ ok: true }))
  );
}

function rejectReadDeclarations(options: SyncRuntimeOptions) {
  // @ts-expect-error a GET's identity is its URL: reads declare nothing
  return new Elysia().use(furinSync(options)).get("/old", { sync: { id: "board" } }, () => 1);
}

function invalidateOutsideRequests(options: SyncRuntimeOptions) {
  expectTypeOf(
    invalidateSync(options, "/anything/:id", { id: 1 }, { principal: "alice" })
  ).toEqualTypeOf<Promise<void>>();
  expectTypeOf(invalidateSync(options, { tags: ["rule"] }, { principal: "alice" })).toEqualTypeOf<
    Promise<void>
  >();
  // @ts-expect-error principals are stable verified string identities
  invalidateSync(options, { tags: ["rule"] }, { principal: 123 });
  // Until an app is registered, any path and params are accepted, as in a handler.
  expectTypeOf(invalidateSync(options, "/anything/:id", { id: 1 })).toEqualTypeOf<Promise<void>>();
  // Like the handler's invalidate(), it also takes cache tags and page paths.
  expectTypeOf(invalidateSync(options, { tags: ["rule"] })).toEqualTypeOf<Promise<void>>();
  expectTypeOf(invalidateSync(options, { path: "/board", type: "layout" })).toEqualTypeOf<
    Promise<void>
  >();
  // @ts-expect-error a page path needs its revalidation type
  invalidateSync(options, { path: "/board" });
}

test("invalidate() targets the app's GET patterns with params typed from the pattern", () => {
  expectTypeOf<Patterns>().toEqualTypeOf<
    "/api/boards" | "/api/boards/:boardId" | "/api/cards/:id"
  >();
  expectTypeOf<SyncParams<"/api/boards/:boardId">>().toEqualTypeOf<{
    readonly boardId?: string | number;
  }>();
  expectTypeOf(assertInvalidate).toBeFunction();
  expectTypeOf(syncRouteOptions).toBeFunction();
  expectTypeOf(rejectReadDeclarations).toBeFunction();
  expectTypeOf(invalidateOutsideRequests).toBeFunction();
});
