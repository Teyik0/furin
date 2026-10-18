import { afterEach, beforeEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createClient } from "../../../src/client.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createDataEndpoint, createRoutePlugin } from "../../../src/server/router/plugin.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { defer } from "../../../src/shared/defer.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import type { QuerySeed } from "../../../src/shared/sync-query.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const SECRET = "reset-token-7f3a91";
const identity = { id: "account", scope: {}, session: "alice" };
let previousDevMode: boolean;
beforeEach(() => {
  previousDevMode = IS_DEV;
  __setDevMode(false);
});
afterEach(() => __setDevMode(previousDevMode));

function accountApi() {
  return createClient(
    new Elysia().get("/account", ({ set }) => {
      set.headers["x-furin-query"] = JSON.stringify(identity);
      return { profile: { displayName: "Alice" }, passwordResetToken: SECRET };
    })
  );
}

type Account = Awaited<ReturnType<ReturnType<typeof accountApi>["account"]["get"]>>["data"];

// biome-ignore lint/style/useConsistentTypeDefinitions: only an alias satisfies the loader's index signature.
type LoaderOutput = {
  account?: Account;
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
  const definition = defineRoute()
    .config({ layout, mode: "ssr" })
    .loader(() => loader(api))
    .page(() => <main>Account</main>);
  const root = { path: "/root.tsx", route: adaptDefinedLayout(layout, undefined) };
  const page = adaptDefinedPage(definition, root.route);
  const route = {
    mode: "ssr" as const,
    page,
    path: "/account.tsx",
    pattern: "/account",
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
  return { root, route };
}

async function transports(loader: Parameters<typeof routeFor>[0]) {
  const { root, route } = routeFor(loader);
  const html = await (
    await new Elysia()
      .use(createRoutePlugin(route, root, "test"))
      .handle(new Request("http://localhost/account"))
  ).text();
  const navigation = await new Elysia()
    .use(createDataEndpoint([route], root))
    .handle(new Request("http://localhost/_furin/data?path=/account"));
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
      displayName: (await api.account.get()).data?.profile.displayName,
    }),
  ],
  [
    "a read bound only through a nested object",
    async (api: ReturnType<typeof accountApi>) => ({
      profile: (await api.account.get()).data?.profile,
    }),
  ],
  [
    "a deferred unbound read",
    (api: ReturnType<typeof accountApi>) =>
      defer({
        displayName: api.account.get().then(({ data }) => data?.profile.displayName),
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
    account: (await api.account.get()).data as Account,
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

test("a later deferred field does not erase a body returned whole by the loader", async () => {
  const { seeds } = await transports(async (api) => {
    const account = (await api.account.get()).data as Account;
    return defer({ account, later: Promise.resolve("done") });
  });
  expect(seeds).toMatchObject([{ identity, data: { passwordResetToken: SECRET } }]);
});
