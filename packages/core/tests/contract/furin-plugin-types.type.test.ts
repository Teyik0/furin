// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time public contract assertions.
import { test } from "bun:test";
import { Elysia, t } from "elysia";
import type { RequestLogger } from "evlog";
import { expectTypeOf } from "expect-type";
import { createClient } from "../../src/client.ts";
import { defineRootRoute, defineRoute, furin, furinSync } from "../../src/furin.ts";
import type { SyncRuntimeOptions } from "../../src/server/sync/index.ts";

async function composePublicApplication(options: SyncRuntimeOptions) {
  const app = new Elysia({ prefix: "/api" })
    .decorate("featureFlag", true)
    .use(furinSync(options))
    .get("/before", { query: t.Object({ value: t.Number() }) }, ({ query }) => ({
      value: query.value,
    }))
    .use(await furin({ pagesDir: "./src/pages", sync: options }))
    .get("/logged", ({ log }) => {
      expectTypeOf(log).toEqualTypeOf<RequestLogger>();
      return { ready: true };
    })
    .post(
      "/after",
      { body: t.Object({ title: t.String() }), sync: false },
      ({ body, mutation, featureFlag }) => {
        expectTypeOf(mutation).toBeFunction();
        expectTypeOf(featureFlag).toEqualTypeOf<boolean>();
        return { title: body.title };
      }
    );
  const api = createClient<typeof app>("http://localhost");
  expectTypeOf<
    NonNullable<Awaited<ReturnType<typeof api.api.before.get>>["data"]>
  >().toEqualTypeOf<{ value: number }>();
  expectTypeOf<
    NonNullable<Awaited<ReturnType<typeof api.api.after.post>>["data"]>
  >().toEqualTypeOf<{ title: string }>();
  // @ts-expect-error composed routes preserve the GET query schema
  api.api.before.get({ query: { value: "wrong" } });
  // @ts-expect-error composed routes preserve the POST body schema
  api.api.after.post({ title: 42 });
  // @ts-expect-error framework plugins must not widen all client routes to any
  api.api.missing.get();
  return app;
}

function definePublicPage() {
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => children);
  return defineRoute()
    .config({ layout, mode: "ssr", query: t.Object({ page: t.Number() }) })
    .loader(({ log, query }) => {
      expectTypeOf(log).toEqualTypeOf<RequestLogger>();
      expectTypeOf(query.page).toEqualTypeOf<number>();
      return { page: query.page };
    })
    .page(({ page }) => {
      expectTypeOf(page).toEqualTypeOf<number>();
      return String(page);
    });
}

test("Furin composition preserves native routes, logger, sync and page configuration types", () => {
  expectTypeOf(composePublicApplication).toBeFunction();
  expectTypeOf(definePublicPage).toBeFunction();
});
