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
      expectTypeOf(error.value.detail).toEqualTypeOf<string>();
      if (error.status === 0) {
        expectTypeOf(error).toEqualTypeOf<EdenFetchError<0, { detail: string }>>();
      } else {
        expectTypeOf(error.status).toEqualTypeOf<422>();
        expectTypeOf(error.value.detail).toEqualTypeOf<string>();
      }
    },
  });
  expectTypeOf(save.mutate).parameters.toEqualTypeOf<Parameters<typeof api.cards.post>>();
  expectTypeOf(save.data).toEqualTypeOf<
    Awaited<ReturnType<typeof api.cards.post>>["data"] | undefined
  >();
  expectTypeOf(save.error?.value.detail).toEqualTypeOf<string | undefined>();
  expectTypeOf(save.error?.status).toEqualTypeOf<422 | 0 | undefined>();
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
  const business = useMutation(async () => ({
    data: null,
    error: { status: 409 as const, value: { code: "CONFLICT" as const } },
  }));
  if (business.error?.status === 409) {
    expectTypeOf(business.error.value.code).toEqualTypeOf<"CONFLICT">();
    expectTypeOf(business.error.value.detail).toEqualTypeOf<string>();
  }
  const nullable = useMutation(async () => ({
    data: null,
    error: { status: 502 as const, value: null },
  }));
  if (nullable.error) {
    expectTypeOf(nullable.error.value.detail).toEqualTypeOf<string>();
  }
  const text = useMutation(async () => ({
    data: null,
    error: { status: 503 as const, value: "Unavailable" },
  }));
  if (text.error) {
    expectTypeOf(text.error.value.detail).toEqualTypeOf<string>();
  }
  const mixed = useMutation(async (hasBody: boolean) => ({
    data: null,
    error: { status: 502 as const, value: hasBody ? { detail: "Unavailable" } : null },
  }));
  if (mixed.error) {
    expectTypeOf(mixed.error.value.detail).toEqualTypeOf<string>();
  }
  // @ts-expect-error external API inputs are inferred
  external.mutate(1);
}

test("mutation methods preserve their argument, response and error types", () => {
  expect(assertMutationTypes).toBeFunction();
});
