import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Suspense, use } from "react";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import {
  isPprArtifact,
  prerenderPprDocument,
  resumePprDocument,
} from "../../../src/server/render/ppr-document.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const previousDevMode = IS_DEV;
__setDevMode(false);
afterAll(async () => {
  __setDevMode(previousDevMode);
  await Promise.resolve();
});

test("a serialized public shell resumes independently for two sessions", async () => {
  let publicCalls = 0;
  let privateCalls = 0;
  const privateReady = Promise.withResolvers<void>();
  const rootRoute = defineRootRoute()
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
  function Private({ data }: { data: Promise<{ user: string | undefined }> }) {
    return <strong>{use(data).user}</strong>;
  }
  const terminal = defineRoute()
    .config({ layout: rootRoute, mode: "isr", revalidate: 60 })
    .requestLoader(async ({ cookies }) => {
      privateCalls += 1;
      if (cookies.get("session") === "Alice") {
        await privateReady.promise;
      }
      return { user: String(cookies.get("session")) };
    })
    .loader(() => {
      publicCalls += 1;
      return { title: "Public shell é" };
    })
    .page(({ data, requestData }) => (
      <main>
        <h1>{data.title}</h1>
        <Suspense fallback="Loading">
          <Private data={requestData} />
        </Suspense>
      </main>
    ));
  const root = { path: "/root.tsx", route: adaptDefinedLayout(rootRoute, undefined) };
  const page = adaptDefinedPage(terminal, root.route);
  const route = {
    mode: "isr" as const,
    page,
    path: "/account.tsx",
    pattern: "/account",
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
  let artifact: Awaited<ReturnType<typeof prerenderPprDocument>> | undefined;
  const app = new Elysia().get("/account", async (ctx) => {
    if (artifact === undefined) {
      artifact = await prerenderPprDocument(route, ctx, root, "build-1", undefined, undefined);
      expect(privateCalls).toBe(0);
    }
    if (!isPprArtifact(artifact)) {
      throw new Error("Prerender failed");
    }
    return resumePprDocument(route, ctx, root, JSON.parse(JSON.stringify(artifact)), undefined);
  });
  const alice = await app.handle(
    new Request("http://localhost/account", { headers: { cookie: "session=Alice" } })
  );
  const shellReader = alice.clone().body?.getReader();
  if (shellReader === undefined) {
    throw new Error("Missing shell stream");
  }
  const first = await shellReader.read();
  expect(new TextDecoder().decode(first.value)).toContain("Public shell é");
  expect(new TextDecoder().decode(first.value)).not.toContain("Alice");
  privateReady.resolve();
  const aliceHtml = await alice.text();
  await shellReader.cancel();
  const bob = await app.handle(
    new Request("http://localhost/account", { headers: { cookie: "session=Bob" } })
  );
  const bobHtml = await bob.text();
  expect(alice.status).toBe(200);
  expect(bob.status).toBe(200);
  expect(artifact).toBeDefined();
  if (!isPprArtifact(artifact)) {
    throw new Error("Missing PPR artifact");
  }
  expect(artifact.html).toContain("Public shell é");
  expect(artifact.html).toContain("Loading");
  expect(artifact.html).not.toContain("Alice");
  expect(artifact.html).not.toContain("Bob");
  expect(artifact.state.postponed).not.toBeNull();
  expect(aliceHtml).toContain("Alice");
  expect(bobHtml).toContain("Bob");
  expect(bobHtml).not.toContain("Alice");
  expect(bobHtml.match(/<\/html>/g)).toHaveLength(1);
  expect(bob.headers.get("cache-control")).toBe("private, no-store");
  expect(publicCalls).toBe(1);
  expect(privateCalls).toBe(2);
});
