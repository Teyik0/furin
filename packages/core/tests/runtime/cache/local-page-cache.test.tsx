import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { buildRoutePrerenders } from "../../../src/build/ssg-cache.ts";
import { defineRootRoute, defineRoute, HeadContent, Scripts } from "../../../src/furin.ts";
import { __resetCacheState, revalidatePath } from "../../../src/server/cache/index.ts";
import { adaptDefinedLayout, adaptDefinedPage } from "../../../src/server/router/defined-route.ts";
import { createRoutePlugin } from "../../../src/server/router/plugin.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode, IS_DEV } from "../../../src/server/runtime-env.ts";
import { collectRouteChainFromRoute } from "../../../src/shared/utils/index.ts";

const originalDevMode = IS_DEV;
const rootTerminal = defineRootRoute()
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
const root = {
  path: "/root.tsx",
  route: adaptDefinedLayout(rootTerminal, undefined),
} satisfies RootLayout;

function resolveRoute(terminal: Parameters<typeof adaptDefinedPage>[0]): ResolvedRoute {
  const page = adaptDefinedPage(terminal, root.route);
  return {
    mode: page.mode ?? "ssr",
    page,
    path: "/catalog.tsx",
    pattern: "/catalog",
    routeChain: collectRouteChainFromRoute(page._route),
    segmentBoundaries: [],
  };
}

beforeAll(() => __setDevMode(false));
afterEach(() => __resetCacheState());
afterAll(() => __setDevMode(originalDevMode));

test("SSG invalidation during the first render prevents caching old data", async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let loaderCalls = 0;
  const terminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssg" })
    .loader(async () => {
      loaderCalls += 1;
      started.resolve();
      await gate.promise;
      return { value: "old" };
    })
    .page(({ value }) => <main>{value}</main>);
  const app = new Elysia().use(createRoutePlugin(resolveRoute(terminal), root, "build"));
  const first = app.handle(new Request("http://localhost/catalog"));
  await started.promise;
  await revalidatePath("/catalog", "page");
  gate.resolve();
  const response = await first;

  expect(response.headers.get("cache-control")).toBe("no-store");
  await app.handle(new Request("http://localhost/catalog"));
  expect(loaderCalls).toBe(2);
});

test("PPR invalidation during the first render prevents caching the old shell", async () => {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let loaderCalls = 0;
  const terminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssg" })
    .requestLoader(() => ({ user: "alice" }))
    .loader(async () => {
      loaderCalls += 1;
      started.resolve();
      await gate.promise;
      return { value: "old" };
    })
    .page(({ value }) => <main>{value}</main>);
  const route = { ...resolveRoute(terminal), requestKeys: ["user"] };
  const app = new Elysia().use(createRoutePlugin(route, root, "build"));
  const first = app.handle(new Request("http://localhost/catalog"));
  await started.promise;
  await revalidatePath("/", "layout");
  gate.resolve();
  await (await first).text();

  await (await app.handle(new Request("http://localhost/catalog"))).text();
  expect(loaderCalls).toBe(2);
});

test("SSG shell failures return 500 without caching the error page", async () => {
  let renders = 0;
  const terminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssg" })
    .loader(() => ({}))
    .page(() => {
      renders += 1;
      if (renders === 1) {
        throw new Error("SSG shell failed");
      }
      return <main>recovered</main>;
    });
  const app = new Elysia().use(createRoutePlugin(resolveRoute(terminal), root, "build"));
  const failed = await app.handle(new Request("http://localhost/catalog"));

  expect(failed.status).toBe(500);
  expect(failed.headers.get("cache-control")).toBe("no-store");
  const recovered = await app.handle(new Request("http://localhost/catalog"));
  expect(recovered.status).toBe(200);
  expect(await recovered.text()).toContain("recovered");
});

test("SSG build prerendering rejects a failed React shell", async () => {
  const terminal = defineRoute()
    .config({ layout: rootTerminal, mode: "ssg" })
    .loader(() => ({}))
    .page(() => {
      throw new Error("SSG build shell failed");
    });

  await expect(
    buildRoutePrerenders([resolveRoute(terminal)], root, "http://localhost", "")
  ).rejects.toThrow("HTTP 500");
});
