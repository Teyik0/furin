import { afterAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { Suspense, use } from "react";
import { clientModule, preloadClientModule } from "../../../src/client/client-module.ts";
import {
  defineRootRoute,
  defineRoute,
  furinCsp,
  HeadContent,
  Scripts,
} from "../../../src/furin.ts";
import { __resetCompileContext } from "../../../src/server/internal.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { mountProductionApp } from "../../support/production-app.ts";

const noncePattern = /'nonce-([^']+)'/;
const scriptTagPattern = /<script\b[^>]*>/g;
const previousDevMode = IS_DEV;
__setDevMode(false);
afterAll(() => {
  __resetCompileContext();
  __setDevMode(previousDevMode);
});

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

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/csp/account": {
      kind: "page";
      parent: typeof rootRoute;
      pathParams: NonNullable<unknown>;
    };
  }
}

test("SSR emits a fresh CSP nonce on framework and authored scripts", async () => {
  const page = defineRoute("/csp/account")
    .config({ mode: "ssr" })
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
  const { app: furinApp } = await mountProductionApp({
    buildId: "build-1",
    pages: [{ pattern: "/account", requestKeys: ["user"], route: page }],
    root: rootRoute,
  });
  const app = new Elysia()
    .use(
      furinCsp({
        policy: (nonce) =>
          `default-src 'self'; script-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; object-src 'none'`,
      })
    )
    .use(furinApp);

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
