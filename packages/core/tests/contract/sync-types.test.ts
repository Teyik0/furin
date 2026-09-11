// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { test } from "bun:test";
import { expectTypeOf } from "expect-type";
import type {
  PollingSyncNotifier,
  SyncNotifier,
  SyncRuntimeOptions,
} from "../../src/server/sync/index.ts";

declare const Elysia: typeof import("elysia").Elysia;
declare const furinSync: typeof import("../../src/furin.ts").furinSync;

type SyncModule = typeof import("../../src/server/sync/index.ts");
type FurinModule = typeof import("../../src/furin.ts");

interface TypeBoard {
  id: string;
}

function createSyncTypeContractApp(options: SyncRuntimeOptions) {
  const boardPlugin = new Elysia()
    .use(furinSync(options))
    .get("/boards", (): TypeBoard[] => [{ id: "board-1" }])
    .post("/boards", (): TypeBoard => ({ id: "board-1" }));
  const downloadPlugin = new Elysia()
    .use(furinSync(options))
    .get("/download", () => new Response("content"));

  return new Elysia({ prefix: "/api" }).use(boardPlugin).use(downloadPlugin);
}

test("sync entrypoints require an explicit runtime", () => {
  type ChangesOptions = Parameters<SyncModule["createSyncChangesPlugin"]>[0];
  type PluginOptions = Parameters<SyncModule["furinSync"]>[0];
  type FurinOptions = NonNullable<Parameters<FurinModule["furin"]>[0]>;

  expectTypeOf<ChangesOptions>().toExtend<SyncRuntimeOptions>();
  expectTypeOf<PluginOptions>().toEqualTypeOf<SyncRuntimeOptions>();
  expectTypeOf<Parameters<SyncModule["furinSync"]>>().toEqualTypeOf<
    [options: SyncRuntimeOptions]
  >();
  expectTypeOf<false>().toExtend<FurinOptions["sync"]>();
  expectTypeOf<true>().not.toExtend<FurinOptions["sync"]>();
});

test("sync transport responses do not widen route success payloads", () => {
  type Routes = ReturnType<typeof createSyncTypeContractApp>["~Routes"];

  expectTypeOf<Routes["api"]["boards"]["get"]["response"][200]>().toEqualTypeOf<TypeBoard[]>();
  expectTypeOf<Routes["api"]["boards"]["post"]["response"][200]>().toEqualTypeOf<TypeBoard>();
  expectTypeOf<Routes["api"]["download"]["get"]["response"][200]>().toEqualTypeOf<Response>();
});

test("public sync surface excludes memory implementations", () => {
  expectTypeOf<"MemorySyncAdapter">().not.toExtend<keyof SyncModule>();
  expectTypeOf<"MemorySyncNotifier">().not.toExtend<keyof SyncModule>();
});

test("public polling notifier remains usable as an instance type", () => {
  expectTypeOf<
    InstanceType<SyncModule["PollingSyncNotifier"]>
  >().toEqualTypeOf<PollingSyncNotifier>();
  expectTypeOf<PollingSyncNotifier>().toExtend<SyncNotifier>();
});
