// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { createClient, type OptimisticCache, useQuery } from "../../src/client.ts";

const app = new Elysia()
  .get("/cards", { query: t.Object({ boardId: t.String() }) }, () => [{ id: "1", title: "Card" }])
  .get("/count", () => ({ total: 1 }))
  .patch("/cards/:id", { body: t.Object({ title: t.String() }) }, ({ body }) => body);
const raw = treaty(app);
const api = createClient(app);

function assertQueryTypes(cache: OptimisticCache) {
  const count = useQuery(api.count.get);
  expectTypeOf(count.data).toEqualTypeOf<{ total: number } | undefined>();
  const selected = useQuery(api.cards.get, {
    query: { boardId: "a" },
    select: (cards) => cards.length,
  });
  expectTypeOf(selected.data).toEqualTypeOf<number | undefined>();
  cache.update(
    api.cards.get,
    (cards) => {
      expectTypeOf(cards).toEqualTypeOf<{ id: string; title: string }[]>();
      return cards;
    },
    { query: { boardId: "a" } }
  );
  // @ts-expect-error required Eden query arguments stay required
  useQuery(api.cards.get);
  // @ts-expect-error optimistic targets require the same GET query arguments
  cache.update(api.cards.get, (cards) => cards);
  // @ts-expect-error the GET must be wrapped with withSync
  useQuery(raw.count.get);
  // @ts-expect-error useQuery accepts GET methods only
  useQuery(api.cards({ id: "1" }).patch);
  // @ts-expect-error selectors receive the GET data type
  useQuery(api.count.get, { select: (data) => data.missing });
  // @ts-expect-error query schema stays typed
  useQuery(api.cards.get, { query: { boardId: 123 } });
  // @ts-expect-error optimistic transformations must return complete GET data
  cache.update(api.count.get, () => ({ wrong: true }));
}

test("Eden query hooks and optimistic targets keep schema inference", () => {
  expectTypeOf(assertQueryTypes).toBeFunction();
  expectTypeOf<ReturnType<typeof api.count.get>>().toEqualTypeOf<
    ReturnType<typeof raw.count.get>
  >();
});
