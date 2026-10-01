// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { type OptimisticCache, withSync } from "../../src/client.ts";

interface CardsLoader {
  cards: { id: string; column: "todo" | "done" }[];
  title: string;
}
declare module "@teyik0/furin/routes" {
  interface RouteMap {
    [path: `/sync-board/${string}`]: {
      elysia: { "~Routes": { get: { params: { boardId: string } } } };
      useLoaderData: () => CardsLoader;
    };
  }
  interface RoutePatternMap {
    "/sync-board/:boardId": {
      elysia: { "~Routes": { get: { params: { boardId: string } } } };
      useLoaderData: () => CardsLoader;
    };
  }
}

const app = new Elysia().patch(
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
const api = withSync(eden, { retry: 2 });

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
  // @ts-expect-error generated routes retain body schema validation
  api.cards({ id: "1" }).patch({ column: "invalid" });
  // @ts-expect-error retry is a number
  api.cards({ id: "1" }).patch({ column: "todo" }, { retry: true });
}

test("withSync preserves Eden results and adds typed mutation options", () => {
  expectTypeOf<ReturnType<ReturnType<typeof api.cards>["patch"]>>().toEqualTypeOf<
    ReturnType<ReturnType<typeof eden.cards>["patch"]>
  >();
  expectTypeOf(assertOptions).toBeFunction();
});
