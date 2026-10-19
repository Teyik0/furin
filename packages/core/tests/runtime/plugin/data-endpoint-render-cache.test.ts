import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnyElysia, Elysia } from "elysia";
import type { SsgCacheEntry } from "../../../src/server/cache/isr-ssg.ts";
import { createTmpApp, type TmpApp, writeAppFile } from "../../support/app-fixtures";

const { furin } = await import("../../../src/furin");
const { __resetCacheState } = await import("../../../src/server/cache/index");
const { __resetCompileContext, __setCompileContext } = await import("../../../src/server/internal");
const { __resetTemplateState } = await import("../../../src/server/render/template");
const { __setDevMode } = await import("../../../src/server/runtime-env");

const originalCwd = process.cwd();
const tmpApps: TmpApp[] = [];
const dataRequest = () => new Request("http://furin/?_furin=data");

interface LoaderCounter {
  [key: string]: number | undefined;
}

const counters = globalThis as typeof globalThis & LoaderCounter;

afterEach(() => {
  __setDevMode(true);
  __resetTemplateState();
  __resetCacheState();
  __resetCompileContext();
  process.chdir(originalCwd);
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

/**
 * Mounts a real production `furin()` whose `/` page runs `mode` and counts
 * loader executions under a unique global key. `?_furin=data` requests are
 * served by the compiled native route itself.
 */
async function mountProduction(
  mode: "isr" | "ssg",
  ssgCache: { [path: string]: SsgCacheEntry } | undefined
): Promise<{ app: AnyElysia; loaderCalls: () => number }> {
  const tmpApp = createTmpApp("cli-app");
  tmpApps.push(tmpApp);
  const counterKey = `__furin_render_cache_${mode}_${crypto.randomUUID()}`;
  writeAppFile(
    tmpApp.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      "const counters = globalThis as typeof globalThis & { [key: string]: number | undefined };",
      'export const route = defineRoute("/")',
      `  .config({ mode: "${mode}", revalidate: 60 })`,
      "  .loader(() => {",
      `    counters[${JSON.stringify(counterKey)}] = (counters[${JSON.stringify(counterKey)}] ?? 0) + 1;`,
      '    return { headline: "cached headline" };',
      "  })",
      "  .head(() => ({ meta: [{ title: 'Cached title' }] }))",
      "  .page(({ headline }) => <main>{headline}</main>);",
    ].join("\n")
  );
  __setDevMode(false);
  process.chdir(tmpApp.path);

  const rootPath = join(tmpApp.path, "src/pages/root.tsx");
  const indexPath = join(tmpApp.path, "src/pages/index.tsx");
  const [rootMod, indexMod] = await Promise.all([import(rootPath), import(indexPath)]);
  const clientDir = join(tmpApp.path, "native-client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(
    join(clientDir, "index.html"),
    '<html><head><!--furin-head--></head><body><div id="root"><!--ssr-outlet--></div></body></html>'
  );
  const nativeRoutes = new Elysia().use((indexMod.route as { elysia: AnyElysia }).elysia);
  __setCompileContext({
    embedded: { clientDir },
    modules: { [indexPath]: indexMod, [rootPath]: rootMod },
    nativeRoutes,
    rootConventions: {},
    rootPath,
    routeMetadata: { [indexPath]: { segmentBoundaries: [] } },
    routes: [{ mode, path: indexPath, pattern: "/" }],
    ...(ssgCache === undefined ? {} : { ssgCache }),
  });

  const app = new Elysia().use(await furin({ pagesDir: join(tmpApp.path, "src/pages") }));
  return { app, loaderCalls: () => counters[counterKey] ?? 0 };
}

test.serial("ISR navigation data is served from the render cache within the window", async () => {
  const { app, loaderCalls } = await mountProduction("isr", undefined);

  const first = await app.handle(dataRequest());
  const firstBody = await first.text();
  const second = await app.handle(dataRequest());
  const secondBody = await second.text();
  const document = await app.handle(new Request("http://furin/"));

  expect(first.status).toBe(200);
  expect(first.headers.get("content-type")).toContain("application/x-ndjson");
  expect(first.headers.get("cache-control")).toBe(
    "public, max-age=0, s-maxage=60, stale-while-revalidate=60"
  );
  expect(firstBody).toContain("cached headline");
  expect(firstBody).toContain("Cached title");
  expect(secondBody).toBe(firstBody);
  expect(second.headers.get("cache-control")).toBe(first.headers.get("cache-control"));
  expect(await document.text()).toContain("cached headline");
  expect(loaderCalls()).toBe(1);
});

test.serial("ISR navigation data reuses the entry rendered by a document request", async () => {
  const { app, loaderCalls } = await mountProduction("isr", undefined);

  await (await app.handle(new Request("http://furin/"))).text();
  const data = await app.handle(dataRequest());

  expect(await data.text()).toContain("cached headline");
  expect(loaderCalls()).toBe(1);
});

test.serial(
  "SSG navigation data never runs the loader when the build cached the page",
  async () => {
    const ndjson = '{"headline":"from build snapshot"}\n';
    const { app, loaderCalls } = await mountProduction("ssg", {
      "/": { cachedAt: 1, html: "<html>snapshot</html>", ndjson, status: 200 },
    });

    const data = await app.handle(dataRequest());

    expect(data.status).toBe(200);
    expect(data.headers.get("content-type")).toContain("application/x-ndjson");
    expect(data.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate, s-maxage=31536000"
    );
    expect(await data.text()).toBe(ndjson);
    expect(loaderCalls()).toBe(0);
  }
);

test.serial("SSG navigation data and documents share one runtime render", async () => {
  const { app, loaderCalls } = await mountProduction("ssg", undefined);

  const first = await app.handle(dataRequest());
  const firstBody = await first.text();
  await (await app.handle(new Request("http://furin/"))).text();
  const second = await app.handle(dataRequest());

  expect(firstBody).toContain("cached headline");
  expect(firstBody).toContain("Cached title");
  expect(await second.text()).toBe(firstBody);
  expect(loaderCalls()).toBe(1);
});
