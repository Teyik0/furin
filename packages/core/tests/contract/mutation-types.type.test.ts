// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time assertions.
import { expect, test } from "bun:test";
import type { EdenFetchError } from "@elysia/eden";
import { Elysia, t } from "elysia";
import { expectTypeOf } from "expect-type";
import { createClient, useMutation } from "../../src/client.ts";

const app = new Elysia()
  .get("/cards/:id", () => ({ id: "1", title: "Before" }))
  .post("/cards", { body: t.Object({ title: t.String() }) }, ({ body, status }) =>
    body.title ? { id: "1", title: body.title } : status(422, { detail: "Invalid title" })
  )
  .delete("/cards/:id", () => ({ ok: true as const }));
const api = createClient(app);

function assertMutationTypes() {
  const save = useMutation(api.cards.post, {
    onSuccess(data) {
      expectTypeOf(data).toEqualTypeOf<Awaited<ReturnType<typeof api.cards.post>>["data"]>();
    },
    onError(error) {
      expectTypeOf(error.value.detail).toEqualTypeOf<string | undefined>();
      if (error.status === 0) {
        expectTypeOf(error).toEqualTypeOf<EdenFetchError<0, { detail: string }>>();
      } else {
        expectTypeOf(error).toEqualTypeOf<
          NonNullable<Awaited<ReturnType<typeof api.cards.post>>["error"]>
        >();
      }
    },
  });
  expectTypeOf(save.mutate).parameters.toEqualTypeOf<Parameters<typeof api.cards.post>>();
  expectTypeOf(save.data).toEqualTypeOf<
    Awaited<ReturnType<typeof api.cards.post>>["data"] | undefined
  >();
  expectTypeOf(save.error).toEqualTypeOf<
    | NonNullable<Awaited<ReturnType<typeof api.cards.post>>["error"]>
    | EdenFetchError<0, { detail: string }>
    | null
  >();
  save.mutate(
    { title: "Draft" },
    {
      optimistic(cache) {
        cache.update(api.cards({ id: "1" }).get, (data) => data);
      },
    }
  );
  // @ts-expect-error required body is preserved
  save.mutate();
  // @ts-expect-error body field types are preserved
  save.mutate({ title: 1 });
  // @ts-expect-error retry remains numeric
  save.mutate({ title: "Draft" }, { retry: true });
  const remove = useMutation(api.cards({ id: "1" }).delete);
  remove.mutate();
  const external = useMutation(async (title: string) => ({ data: { title }, error: null }));
  expectTypeOf(external.mutateAsync).returns.toEqualTypeOf<Promise<{ title: string }>>();
  expectTypeOf(external.error).toEqualTypeOf<EdenFetchError<0, { detail: string }> | null>();
  const externalFailure = useMutation(async () => ({ data: null, error: new Error("Failed") }));
  expectTypeOf(externalFailure.error).toEqualTypeOf<EdenFetchError<0, { detail: string }> | null>();
  // @ts-expect-error external API inputs are inferred
  external.mutate(1);
}

test("mutation methods preserve their argument, response and error types", () => {
  expect(assertMutationTypes).toBeFunction();
});
