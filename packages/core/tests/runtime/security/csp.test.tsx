import { afterAll, expect, test } from "bun:test";
import { Elysia, NotFound } from "elysia";
import { Suspense, use } from "react";
import { clientModule, preloadClientModule } from "../../../src/client/client-module.ts";
import {
  defineRootRoute,
  defineRoute,
  furinCsp,
  HeadContent,
  Scripts,
} from "../../../src/furin.ts";
import { renderRootNotFound } from "../../../src/server/render/not-found.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const noncePattern = /'nonce-([^']+)'/;
const scriptTagPattern = /<script\b[^>]*>/g;
const previousDevMode = IS_DEV;
__setDevMode(false);
afterAll(() => __setDevMode(previousDevMode));

test("SSR emits a fresh CSP nonce on framework and authored scripts", async () => {
  const rootRoute = defineRootRoute()
    .config({ mode: "ssr" })
    .requestLoader(() => ({ user: "Alice" }))
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
  const page = defineRoute()
    .config({ layout: rootRoute, mode: "ssr" })
    .loader(() => ({ title: "Account" }))
    .head(() => ({ scripts: [{ children: "window.accountReady = true" }] }))
    .page(({ title, user }) => (
      <main>
        {title}
        <Suspense fallback="Loading">
          <User data={user} />
        </Suspense>
      </main>
    ));
  function User({ data }: { data: Promise<string> }) {
    const user = use(data);
    preloadClientModule(clientModule(() => Promise.resolve({}), ["/_client/account.js"]));
    return <strong>{user}</strong>;
  }
  const root = { path: "/root.tsx", route: adaptDefinedLayout(rootRoute, undefined) };
  const definedPage = adaptDefinedPage(page, root.route);
  const route = {
    mode: "ssr" as const,
    page: definedPage,
    path: "/account.tsx",
    pattern: "/account",
    requestKeys: ["user"],
    routeChain: collectRouteChainFromRoute(definedPage._route),
    segmentBoundaries: [],
  };
  const app = new Elysia()
    .use(
      furinCsp({
        policy: (nonce) =>
          `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; object-src 'none'`,
      })
    )
    .use(createRoutePlugin(route, root, "build-1"))
    .error("global", NotFound, ({ request }) => renderRootNotFound(root, request));

  const [first, second] = await Promise.all([
    app.handle(new Request("http://localhost/account")),
    app.handle(new Request("http://localhost/account")),
  ]);
  const firstNonce = first.headers.get("content-security-policy")?.match(noncePattern)?.[1];
  const secondNonce = second.headers.get("content-security-policy")?.match(noncePattern)?.[1];
  const html = await first.text();

  expect(firstNonce).toBeTruthy();
  expect(secondNonce).toBeTruthy();
  expect(secondNonce).not.toBe(firstNonce);
  expect(html).toContain(`nonce="${firstNonce}"`);
  expect(html).toContain("window.accountReady = true");
  expect(html).toContain("Alice");
  const preloadPattern = /<link\b[^>]*rel="modulepreload"[^>]*>/g;
  expect(html.match(preloadPattern)).toHaveLength(1);
  for (const tag of html.match(preloadPattern) ?? []) {
    expect(tag).toContain(`nonce="${firstNonce}"`);
  }
  const secondHtml = await second.text();
  expect(secondHtml.match(preloadPattern)).toHaveLength(1);
  for (const tag of secondHtml.match(preloadPattern) ?? []) {
    expect(tag).toContain(`nonce="${secondNonce}"`);
  }
  for (const tag of html.match(scriptTagPattern) ?? []) {
    if (!tag.includes('type="application/json"')) {
      expect(tag).toContain(`nonce="${firstNonce}"`);
    }
  }

  const missing = await app.handle(new Request("http://localhost/missing"));
  const missingNonce = missing.headers.get("content-security-policy")?.match(noncePattern)?.[1];
  expect(missing.status).toBe(404);
  expect(missingNonce).toBeTruthy();
  expect(await missing.text()).toContain(`nonce="${missingNonce}"`);
});
