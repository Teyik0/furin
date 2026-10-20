// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { furinSync, type OptimisticCache } from "../../src/client.ts";

interface CardsLoader {
  cards: { id: string; column: "todo" | "done" }[];
  title: string;
}
declare module "@teyik0/furin/routes" {
  interface RouteMap {
    "/sync-board/:boardId": {
      elysia: { "~Routes": { get: { params: { boardId: string } } } };
      loader: () => CardsLoader;
    };
  }
}

const app = new Elysia()
  .get("/cards/:id", ({ params }) => ({
    id: params.id,
    column: "todo" as "todo" | "done",
  }))
  .get("/health", () => "ok")
  .patch(
    "/cards/:id",
    {
      body: t.Object({ column: t.Union([t.Literal("todo"), t.Literal("done")]) }),
    },
    ({ body, status }) =>
      body.column === "done"
        ? status(409, { code: "locked" as const })
        : { id: "1", column: body.column }
  );
const eden = treaty(app);
const api = eden.use(furinSync);

function assertOptions(cache: OptimisticCache) {
  cache.update("/sync-board/:boardId", (loader) => {
    expectTypeOf(loader).toEqualTypeOf<CardsLoader>();
    return loader;
  });
  // @ts-expect-error the active route already supplies its path params
  cache.update("/sync-board/:boardId", { boardId: "1" }, (loader) => loader);
  // @ts-expect-error unknown named routes are rejected
  cache.update("/missing/:boardId", (loader) => loader);
  cache.update("/sync-board/1", (loader) => {
    expectTypeOf(loader).toEqualTypeOf<CardsLoader>();
    return { ...loader, cards: loader.cards.map((card) => ({ ...card, column: "done" })) };
  });
  // @ts-expect-error a transformation must return all loader fields
  cache.update("/sync-board/1", () => ({ cards: [] }));
  // @ts-expect-error unknown routes are rejected when RouteMap is generated
  cache.update("/missing-sync-route", () => ({}));
  // @ts-expect-error loader field types remain strict
  cache.update("/sync-board/1", (loader) => ({ ...loader, title: 123 }));
  cache.update(api.cards({ id: "1" }).get.live(), (card) => {
    expectTypeOf(card).toEqualTypeOf<{ id: string; column: "todo" | "done" }>();
    return { ...card, column: "done" as const };
  });
  // @ts-expect-error a live transformation must return complete GET data
  cache.update(api.cards({ id: "1" }).get.live(), () => ({ column: "done" }));
  // @ts-expect-error generated routes retain body schema validation
  api.cards({ id: "1" }).patch({ column: "invalid" });
  api.cards({ id: "1" }).patch(
    { column: "todo" },
    {
      optimistic(projection) {
        expectTypeOf(projection).toEqualTypeOf<OptimisticCache>();
      },
    }
  );
  // @ts-expect-error optimistic receives the cache
  api.cards({ id: "1" }).patch({ column: "todo" }, { optimistic: true });
  // @ts-expect-error retry is a useMutation option, not an Eden call option
  api.cards({ id: "1" }).patch({ column: "todo" }, { retry: 2 });
  // Every GET is live: its identity is its URL.
  api.health.get.live();
  // @ts-expect-error a plain Eden client has no live queries
  eden.cards({ id: "1" }).get.live();
}

test("furinSync preserves Eden results and adds live reads and typed mutation options", () => {
  expectTypeOf<ReturnType<ReturnType<typeof api.cards>["patch"]>>().toEqualTypeOf<
    ReturnType<ReturnType<typeof eden.cards>["patch"]>
  >();
  expectTypeOf<Awaited<ReturnType<ReturnType<typeof api.cards>["get"]["live"]>>>().toEqualTypeOf<
    Awaited<ReturnType<ReturnType<typeof eden.cards>["get"]>>
  >();
  expectTypeOf(assertOptions).toBeFunction();
});
