import { afterEach, beforeEach, expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { Elysia } from "elysia";
import { furinSync } from "../../../src/client.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { defer } from "../../../src/shared/defer.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import type { QuerySeed } from "../../../src/shared/sync-query.ts";
import { mountProductionApp } from "../../support/production-app.ts";

const SECRET = "reset-token-7f3a91";
const identity = { id: "account", scope: {}, session: "alice" };
let previousDevMode: boolean;
beforeEach(() => {
  previousDevMode = IS_DEV;
  __setDevMode(false);
});
afterEach(() => {
  __resetCompileContext();
  __setDevMode(previousDevMode);
});

function accountApi() {
  return treaty(
    new Elysia()
      .get("/account", ({ set }) => {
        set.headers["x-furin-query"] = JSON.stringify(identity);
        return { profile: { displayName: "Alice" }, passwordResetToken: SECRET };
      })
      .get("/board", ({ set }) => {
        set.headers["x-furin-query"] = JSON.stringify(identity);
        return { board: { title: "Alpha" }, cards: [{ title: SECRET }] };
      })
      .get("/totals", ({ set }) => {
        set.headers["x-furin-query"] = JSON.stringify(identity);
        return { board: { title: "Alpha" }, cards: [{ title: "Card" }], total: SECRET };
      })
  ).use(furinSync);
}

type Account = Awaited<ReturnType<ReturnType<typeof accountApi>["account"]["get"]>>["data"];

// biome-ignore lint/style/useConsistentTypeDefinitions: only an alias satisfies the loader's index signature.
type LoaderOutput = {
  account?: Account;
  board?: { title: string };
  cards?: { title: string }[];
  displayName?: string | Promise<string | undefined>;
  later?: Promise<string>;
  profile?: { displayName: string };
};

function routeFor(
  loader: (api: ReturnType<typeof accountApi>) => Promise<LoaderOutput> | LoaderOutput
) {
  const api = accountApi();
  const layout = defineRootRoute()
    .config({ mode: "ssr" })
    .layout(({ children }) => (
      <html lang="en">
        <head>
          <HeadContent />
        </head>
        <body>
          {children}
          <Scripts />
        </body>
      </html>
    ));
  const definition = defineRoute("/definition")
    .config({ mode: "ssr" })
    .loader(() => loader(api))
    .page(() => <main>Account</main>);
  return { definition, layout };
}

async function transports(loader: Parameters<typeof routeFor>[0]) {
  const { definition, layout } = routeFor(loader);
  const { app } = await mountProductionApp({
    buildId: "test",
    pages: [{ pattern: "/account", route: definition }],
    root: layout,
  });
  const html = await (await app.handle(new Request("http://localhost/account"))).text();
  const navigation = await app.handle(new Request("http://localhost/account?_furin=data"));
  const payload = await navigation.text();
  const { body } = new Response(payload);
  if (!body) {
    throw new Error("Transport response body missing");
  }
  const parsed = await parseDeferredNdjson(body, undefined);
  await Promise.all(Object.values(parsed.deferredPromises));
  return { html, payload, seeds: parsed.syncData.__furinQueries as QuerySeed[] };
}

test.each([
  [
    "an unbound read",
    async (api: ReturnType<typeof accountApi>) => ({
      displayName: (await api.account.get.live()).data?.profile.displayName,
    }),
  ],
  [
    "a read bound only through a nested object",
    async (api: ReturnType<typeof accountApi>) => ({
      profile: (await api.account.get.live()).data?.profile,
    }),
  ],
  [
    "a deferred unbound read",
    (api: ReturnType<typeof accountApi>) =>
      defer({
        displayName: api.account.get.live().then(({ data }) => data?.profile.displayName),
      }),
  ],
])("%s never transports the full GET response", async (_, loader) => {
  const { html, payload, seeds } = await transports(loader);
  expect(html).toContain("Account");
  expect(html).not.toContain(SECRET);
  expect(payload).not.toContain(SECRET);
  // The dependency itself survives so cache tags and sync refreshes still target the route.
  expect(seeds).toMatchObject([{ identity }]);
  expect(seeds[0]?.data).toBeUndefined();
});

test("a GET response returned whole still hydrates", async () => {
  const { html, seeds } = await transports(async (api) => ({
    account: (await api.account.get.live()).data as Account,
  }));
  expect(html).toContain(SECRET);
  expect(seeds).toMatchObject([
    {
      identity,
      data: { profile: { displayName: "Alice" }, passwordResetToken: SECRET },
      bindings: [{ source: [], target: ["account"] }],
    },
  ]);
});

test("a GET whose every top-level value is returned by identity still hydrates", async () => {
  const { seeds } = await transports(async (api) => {
    const { data } = await api.board.get.live();
    return { board: data?.board, cards: data?.cards };
  });
  expect(seeds).toMatchObject([
    { identity, data: { board: { title: "Alpha" }, cards: [{ title: SECRET }] } },
  ]);
});

test("a GET with a top-level scalar the loader cannot bind ships no body", async () => {
  const { html, payload, seeds } = await transports(async (api) => {
    const { data } = await api.totals.get.live();
    return { board: data?.board, cards: data?.cards };
  });
  expect(html).not.toContain(SECRET);
  expect(payload).not.toContain(SECRET);
  expect(seeds).toMatchObject([{ identity }]);
  expect(seeds[0]?.data).toBeUndefined();
});

test("a later deferred field does not erase a body returned whole by the loader", async () => {
  const { seeds } = await transports(async (api) => {
    const account = (await api.account.get.live()).data as Account;
    return defer({ account, later: Promise.resolve("done") });
  });
  expect(seeds).toMatchObject([{ identity, data: { passwordResetToken: SECRET } }]);
});
