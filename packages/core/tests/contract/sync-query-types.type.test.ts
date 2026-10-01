import { test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type { SyncRouteOption } from "../../src/server/sync/plugin.ts";

declare module "@teyik0/furin/routes" {
  interface SyncQueryMap {
    "board.cards": { boardId: string | undefined };
    "board.count": { boardId: string | undefined };
    "typed.board": { boardId: string };
    "typed.boards": object;
  }
}

test("registered sync reads and invalidations require a known ID and its scope", () => {
  const read: SyncRouteOption = { id: "typed.board", scope: { boardId: "alpha" } };
  const write: SyncRouteOption = {
    invalidate: { id: "typed.board", scope: { boardId: "alpha" } },
  };
  const unscoped: SyncRouteOption = { id: "typed.boards" };
  expectTypeOf(read).toBeObject();
  expectTypeOf(write).toBeObject();
  expectTypeOf(unscoped).toBeObject();
  // @ts-expect-error unknown query ID
  const wrongRead: SyncRouteOption = { id: "typed.borad", scope: { boardId: "alpha" } };
  // @ts-expect-error scoped reads require a scope
  const missingReadScope: SyncRouteOption = { id: "typed.board" };
  const wrongScope: SyncRouteOption = {
    // @ts-expect-error invalidations require the declared scope fields
    invalidate: { id: "typed.board", scope: { tenant: "alpha" } },
  };
  // @ts-expect-error scope values keep their declared types
  const wrongValue: SyncRouteOption = { invalidate: { id: "typed.board", scope: { boardId: 1 } } };
  // @ts-expect-error unscoped queries do not accept arbitrary scope fields
  const extraScope: SyncRouteOption = {
    invalidate: { id: "typed.boards", scope: { boardId: "alpha" } },
  };
  expectTypeOf([wrongRead, missingReadScope, wrongScope, wrongValue, extraScope]).toBeArray();
});
