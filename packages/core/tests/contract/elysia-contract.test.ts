// biome-ignore-all lint/suspicious/noUnusedExpressions: expect-type assertions are compile-time only

import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import type {
  ElysiaRouteParams,
  ElysiaRouteQuery,
  ElysiaRoutes,
  FurinUnwrap,
} from "../../src/shared/elysia-contract.ts";
import { isTypeBoxObjectSchema } from "../../src/shared/elysia-contract.ts";

const paramsSchema = t.Object({ id: t.Numeric() });
const querySchema = t.Object({ filter: t.Optional(t.String()) });
const route = new Elysia().get(
  "/",
  ({ params, query }) => ({ filter: query.filter, id: params.id }),
  { params: paramsSchema, query: querySchema }
);
const app = new Elysia().use(new Elysia({ prefix: "/boards/:id" }).use(route));

describe("Elysia contract", () => {
  test("recognizes TypeBox object schemas through the compatibility boundary", () => {
    expect(isTypeBoxObjectSchema(t.Object({ id: t.String() }))).toBe(true);
    expect(isTypeBoxObjectSchema(t.String())).toBe(false);
  });

  test("preserves params and optional query types through native composition", () => {
    type Leaf = ElysiaRoutes<typeof app>["boards"][":id"]["get"];

    expectTypeOf<ElysiaRouteParams<Leaf>>().toEqualTypeOf<{ id: number }>();
    expectTypeOf<ElysiaRouteQuery<Leaf>>().toEqualTypeOf<{ filter?: string }>();
    expectTypeOf<FurinUnwrap<typeof querySchema>>().toEqualTypeOf<{ filter?: string }>();
  });

  test("pins the Elysia 1.4 handler-first route signature", () => {
    new Elysia().get("/", ({ params }) => params.id, { params: paramsSchema });

    const invalidHookFirst = () => {
      // @ts-expect-error Elysia 1.4 uses get(path, handler, hook), not hook-first.
      new Elysia().get("/", { params: paramsSchema }, ({ params }) => params.id);
    };
    expectTypeOf(invalidHookFirst).returns.toBeVoid();
  });

  test("propagates parent promises to nested routes without awaiting independent work", async () => {
    const nested = new Elysia()
      .derive({ as: "scoped" }, () => ({ parentData: Promise.resolve({ user: "teyik" }) }))
      .use(
        new Elysia({ prefix: "/:id" }).get("/", async (context) => {
          const { parentData } = context as typeof context & {
            parentData: Promise<{ user: string }>;
          };
          return { id: context.params.id, user: (await parentData).user };
        })
      );
    const composed = new Elysia().use(new Elysia({ prefix: "/boards" }).use(nested));

    const response = await composed.handle(new Request("http://localhost/boards/42"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "42", user: "teyik" });
  });
});
