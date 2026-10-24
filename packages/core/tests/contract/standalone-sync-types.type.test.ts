// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { createLocalSyncClient, type SyncRuntimeOptions } from "../../src/server/sync/index.ts";
import {
  createSyncClient,
  furinSync,
  type SyncClient,
  SyncClientError,
  type SyncReconnectOptions,
} from "../../src/sync-client.ts";

declare const sync: SyncRuntimeOptions;

function assertLocalTypes() {
  const app = new Elysia().get(
    "/state",
    { query: t.Object({ id: t.String() }) },
    ({ status, query }) =>
      query.id === "denied" ? status(403, { code: "DENIED" as const }) : { id: query.id, value: 1 }
  );
  const api = treaty(app).use(furinSync);
  const client = createLocalSyncClient({ app, sync });
  client.subscribe(api.state.get.live({ query: { id: "one" } }), ({ data, error }) => {
    expectTypeOf(data).toEqualTypeOf<{ id: string; value: number } | undefined>();
    if (error && !(error instanceof SyncClientError) && error.status === 403) {
      expectTypeOf(error.value.code).toEqualTypeOf<"DENIED">();
    }
  });
  // @ts-expect-error local subscriptions keep Eden's required query arguments
  api.state.get.live();
  // @ts-expect-error a local client requires the application and its sync runtime
  createLocalSyncClient({ app });
}

test("standalone subscriptions preserve Eden data, arguments and discriminated errors", () => {
  expectTypeOf<Parameters<SyncClient["reconnect"]>>().toEqualTypeOf<
    [options?: SyncReconnectOptions]
  >();
  expectTypeOf(assertLocalTypes).toBeFunction();
  const app = new Elysia().get(
    "/state",
    { query: t.Object({ id: t.String() }) },
    ({ status, query }) =>
      query.id === "denied" ? status(403, { code: "DENIED" as const }) : { id: query.id, value: 1 }
  );
  const api = treaty(app).use(furinSync);
  const client = createSyncClient({ url: "http://e.ly" });
  client.close();
  function assertSubscription() {
    client.subscribe(api.state.get.live({ query: { id: "one" } }), (state) => {
      expectTypeOf(state.data).toEqualTypeOf<{ id: string; value: number } | undefined>();
      type EdenError = Awaited<ReturnType<typeof api.state.get>>["error"];
      expectTypeOf(state.error).toEqualTypeOf<EdenError | SyncClientError | null>();
      if (state.error && !(state.error instanceof SyncClientError) && state.error.status === 403) {
        expectTypeOf(state.error.value.code).toEqualTypeOf<"DENIED">();
      }
    });
    // @ts-expect-error required Eden query parameters stay required
    api.state.get.live();
    // @ts-expect-error subscribers consume live objects, not endpoint functions
    client.subscribe(api.state.get, () => undefined);
  }
  expect(assertSubscription).toBeFunction();
});
