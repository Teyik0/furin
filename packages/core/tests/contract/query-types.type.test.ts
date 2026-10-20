// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { furinSync, type OptimisticCache, useQuery } from "../../src/client.ts";

const app = new Elysia()
  .get("/cards", { query: t.Object({ boardId: t.String() }) }, () => [{ id: "1", title: "Card" }])
  .get("/count", () => ({ total: 1 }))
  .get("/plain", () => ({ ok: true }))
  .patch("/cards/:id", { body: t.Object({ title: t.String() }) }, ({ body }) => body);
const raw = treaty(app);
const api = raw.use(furinSync);

function assertQueryTypes(cache: OptimisticCache) {
  const count = useQuery(api.count.get.live());
  expectTypeOf(count.data).toEqualTypeOf<{ total: number } | undefined>();
  const selected = useQuery(api.cards.get.live({ query: { boardId: "a" } }), {
    select: (cards) => cards.length,
  });
  expectTypeOf(selected.data).toEqualTypeOf<number | undefined>();
  cache.update(api.cards.get.live({ query: { boardId: "a" } }), (cards) => {
    expectTypeOf(cards).toEqualTypeOf<{ id: string; title: string }[]>();
    return cards;
  });
  // @ts-expect-error required Eden query arguments stay required
  api.cards.get.live();
  // @ts-expect-error useQuery subscribes to a live query, not to a GET
  useQuery(api.count.get);
  expectTypeOf(useQuery(api.plain.get.live()).data).toEqualTypeOf<{ ok: boolean } | undefined>();
  // @ts-expect-error selectors receive the GET data type
  useQuery(api.count.get.live(), { select: (data) => data.missing });
  // @ts-expect-error query schema stays typed
  api.cards.get.live({ query: { boardId: 123 } });
  // @ts-expect-error optimistic transformations must return complete GET data
  cache.update(api.count.get.live(), () => ({ wrong: true }));
}

test("live queries keep Eden schema inference for useQuery and optimistic targets", () => {
  expectTypeOf(assertQueryTypes).toBeFunction();
  expectTypeOf<ReturnType<typeof api.count.get>>().toEqualTypeOf<
    ReturnType<typeof raw.count.get>
  >();
  expectTypeOf<Awaited<ReturnType<typeof api.count.get.live>>>().toEqualTypeOf<
    Awaited<ReturnType<typeof raw.count.get>>
  >();
});
