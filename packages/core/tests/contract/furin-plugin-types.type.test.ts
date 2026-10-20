// biome-ignore-all lint/suspicious/noUnusedExpressions: compile-time public contract assertions.
import { test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia, t } from "elysia";
import type { RequestLogger } from "evlog";
import { expectTypeOf } from "expect-type";
import { furinSync as furinSyncClient } from "../../src/client.ts";
import { defineRoute, furin, furinSync } from "../../src/furin.ts";
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
      { body: t.Object({ title: t.String() }), idempotent: false },
      ({ body, mutation, featureFlag }) => {
        expectTypeOf(mutation).toBeFunction();
        expectTypeOf(featureFlag).toEqualTypeOf<boolean>();
        return { title: body.title };
      }
    );
  const api = treaty<typeof app>("http://localhost").use(furinSyncClient);
  expectTypeOf<
    NonNullable<Awaited<ReturnType<typeof api.api.before.get.live>>["data"]>
  >().toEqualTypeOf<{ value: number }>();
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

async function composeGuardedApplications() {
  const auth = new Elysia({ name: "auth" })
    .macro({
      session: {
        derive: () => ({ user: { role: "admin" as const } }),
      },
    })
    .macro({
      admin: {
        session: true,
        beforeHandle({ user }) {
          expectTypeOf(user.role).toEqualTypeOf<"admin">();
        },
      },
    });
  return new Elysia()
    .use(auth)
    .use(await furin({ pagesDir: "./src/pages" }))
    .guard({})
    .guard({ admin: true })
    .use(await furin({ pagesDir: "./src/admin", prefix: "/admin" }))
    .get("/guarded", ({ log, user }) => {
      expectTypeOf(log).toEqualTypeOf<RequestLogger>();
      return user.role;
    })
    .guard({
      // @ts-expect-error macros unknown to the parent stay rejected
      unknownMacro: true,
    });
}

function definePublicPage() {
  return defineRoute("/")
    .config({ mode: "ssr", query: t.Object({ page: t.Number() }) })
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
  expectTypeOf(composeGuardedApplications).toBeFunction();
  expectTypeOf(definePublicPage).toBeFunction();
});
