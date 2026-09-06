import "../../setup/global.ts";

import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildAppOptions } from "../../../src/build/types.ts";
import { __resetCacheState } from "../../../src/server/cache/index.ts";
import { __resetTemplateState } from "../../../src/server/render/template.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { __setDevMode } from "../../../src/server/runtime-env.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { createTmpApp, type TmpApp } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const { buildStaticTarget } = await import("../../../src/adapter/static.ts");

const SSR_STATIC_RE = /SSR.*static/i;
const BASEPATH_RE = /basePath must start with/;
const UNSAFE_DIR_RE = /unsafe to delete/;
const PRERENDER_FAIL_RE = /route\(s\) failed to pre-render/;
const REQUEST_LOADER_STATIC_RE = /requestLoader.*static/i;
const STATIC_EXPORT_RE = /cannot be statically exported/i;
const RUN_SCENARIOS_ENV = "FURIN_RUN_STATIC_TARGET_SCENARIOS";
const tmpApps: TmpApp[] = [];

interface ScenarioWorkerResult {
  error: string | null;
}

function makeApp(fixtureName: string): TmpApp {
  __resetCacheState();
  __resetTemplateState();
  const app = createTmpApp(fixtureName);
  tmpApps.push(app);
  return app;
}

function cleanupTmpApps(): void {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
}

process.on("exit", cleanupTmpApps);

async function scanApp(app: TmpApp) {
  const scanned = await scanPages(join(app.path, "src/pages"));
  return { ...scanned, distDir: join(app.path, "dist") };
}

async function runStaticBuild(fixtureName: string, extra?: Pick<BuildAppOptions, "staticConfig">) {
  const app = makeApp(fixtureName);
  const { root, routes, distDir } = await scanApp(app);
  const manifest = await withBuildStub(() =>
    buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
      staticConfig: { outDir: distDir },
      target: "static",
      ...extra,
    }),
  );
  return { app, distDir, manifest, root, routes };
}

function rejectionError(operation: Promise<unknown>): Promise<Error> {
  return operation.then(
    () => {
      throw new Error("Expected operation to reject");
    },
    (error: unknown) => {
      if (!(error instanceof Error)) {
        throw new TypeError("Expected operation to reject with an Error");
      }
      return error;
    },
  );
}

async function runBuildStaticTargetScenarios(): Promise<void> {
  __setDevMode(false);

  const root: RootLayout = {
    path: "/root.tsx",
    route: { __type: "FURIN_ROUTE" },
  };
  const requestRouteEntry = {
    __type: "FURIN_ROUTE",
    requestLoader: async () => ({ userId: "private" }),
  } satisfies RootLayout["route"];
  const requestRoute: ResolvedRoute = {
    mode: "ssg",
    page: {
      __type: "FURIN_PAGE",
      _route: requestRouteEntry,
      component: () => null,
    },
    path: "/index.tsx",
    pattern: "/",
    routeChain: [requestRouteEntry],
    segmentBoundaries: [],
  };
  let buildError = await rejectionError(
    buildStaticTarget(
      [requestRoute],
      "/tmp/furin-static-test",
      "/tmp/furin-static-test/.build",
      root,
      { target: "static" },
    ),
  );
  expect(buildError.message).toMatch(REQUEST_LOADER_STATIC_RE);
  buildError = await rejectionError(
    buildStaticTarget(
      [],
      "/tmp/furin-static-test",
      "/tmp/furin-static-test/.build",
      { ...root, route: { ...root.route, requestLoader: async () => ({ userId: "private" }) } },
      { target: "static" },
    ),
  );
  expect(buildError.message).toMatch(REQUEST_LOADER_STATIC_RE);

  let result = await runStaticBuild("cli-app");
  expect(existsSync(join(result.distDir, "index.html"))).toBe(true);
  expect(existsSync(join(result.distDir, "blog/hello-world/index.html"))).toBe(true);
  expect(existsSync(join(result.distDir, "404.html"))).toBe(true);
  let html = readFileSync(join(result.distDir, "blog/hello-world/index.html"), "utf8");
  expect(html).toContain("<!DOCTYPE html>");
  expect(existsSync(join(result.distDir, "__furin_data.ndjson"))).toBe(true);
  expect(existsSync(join(result.distDir, "blog/hello-world/__furin_data.ndjson"))).toBe(true);

  const ndjsonText = readFileSync(
    join(result.distDir, "blog/hello-world/__furin_data.ndjson"),
    "utf8",
  );
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(ndjsonText));
      controller.close();
    },
  });
  const parsed = await parseDeferredNdjson(stream, undefined);
  expect(parsed.syncData).toBeInstanceOf(Object);

  let app = makeApp("cli-app-ssr");
  let scanned = await scanApp(app);
  buildError = await rejectionError(
    withBuildStub(() =>
      buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
        staticConfig: { outDir: scanned.distDir },
        target: "static",
      }),
    ),
  );
  expect(buildError.message).toMatch(SSR_STATIC_RE);

  app = makeApp("cli-app-ssr");
  scanned = await scanApp(app);
  buildError = await rejectionError(
    withBuildStub(() =>
      buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
        staticConfig: { outDir: scanned.distDir },
        target: "static",
      }),
    ),
  );
  expect(buildError.message).toMatch("/dashboard");

  app = makeApp("cli-app-ssr");
  scanned = await scanApp(app);
  await withBuildStub(() =>
    buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { onSSR: "skip", outDir: scanned.distDir },
      target: "static",
    }),
  );
  expect(existsSync(join(scanned.distDir, "index.html"))).toBe(true);
  expect(existsSync(join(scanned.distDir, "dashboard/index.html"))).toBe(false);

  app = makeApp("cli-app");
  scanned = await scanApp(app);
  let patchedRoutes = scanned.routes.map((route) =>
    route.pattern.includes(":")
      ? { ...route, page: { ...route.page, staticParams: undefined } }
      : route,
  );
  buildError = await rejectionError(
    withBuildStub(() =>
      buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, {
        staticConfig: { outDir: scanned.distDir },
        target: "static",
      }),
    ),
  );
  expect(buildError.message).toMatch(STATIC_EXPORT_RE);
  await withBuildStub(() =>
    buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { onSSR: "skip", outDir: scanned.distDir },
      target: "static",
    }),
  );
  expect(existsSync(join(scanned.distDir, "index.html"))).toBe(true);
  expect(existsSync(join(scanned.distDir, "blog/hello-world/index.html"))).toBe(false);

  result = await runStaticBuild("cli-app", {
    staticConfig: { basePath: "/furin", outDir: "dist" },
  });
  html = readFileSync(join(result.distDir, "index.html"), "utf8");
  expect(html).toContain("/furin/_client/");
  expect(html).not.toContain('"/_client/');

  app = makeApp("cli-app");
  scanned = await scanApp(app);
  buildError = await rejectionError(
    buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { basePath: "sub-path", outDir: scanned.distDir },
      target: "static",
    }),
  );
  expect(buildError.message).toMatch(BASEPATH_RE);

  result = await runStaticBuild("cli-app", {
    staticConfig: { basePath: "/furin/", outDir: "dist" },
  });
  html = readFileSync(join(result.distDir, "index.html"), "utf8");
  expect(html).toContain("/furin/_client/");
  expect(html).not.toContain("/furin//_client/");

  app = makeApp("cli-app");
  scanned = await scanApp(app);
  buildError = await rejectionError(
    buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { outDir: "/" },
      target: "static",
    }),
  );
  expect(buildError.message).toMatch(UNSAFE_DIR_RE);
  buildError = await rejectionError(
    buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { outDir: app.path },
      target: "static",
    }),
  );
  expect(buildError.message).toMatch(UNSAFE_DIR_RE);
  buildError = await rejectionError(
    buildStaticTarget(scanned.routes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { outDir: join(app.path, "..") },
      target: "static",
    }),
  );
  expect(buildError.message).toMatch(UNSAFE_DIR_RE);

  app = makeApp("cli-app");
  scanned = await scanApp(app);
  const baseRoute = scanned.routes.find(
    (route) => route.mode === "ssg" && !route.pattern.includes(":"),
  )!;
  expect(baseRoute).toBeDefined();
  let route = {
    ...baseRoute,
    page: {
      ...baseRoute.page,
      loader: () =>
        Promise.reject(new Response(null, { headers: { Location: "/home" }, status: 302 })),
    },
    pattern: "/redirect-me",
  };
  let manifest = await withBuildStub(() =>
    buildStaticTarget(
      [route, ...scanned.routes.filter((item) => item.mode === "ssg")],
      app.path,
      join(app.path, ".furin/build"),
      scanned.root,
      {
        staticConfig: { outDir: scanned.distDir },
        target: "static",
      },
    ),
  );
  expect(manifest.renderedRoutes).not.toContain("/redirect-me");
  expect(manifest.skippedRoutes).not.toContain("/redirect-me");
  expect(existsSync(join(scanned.distDir, "redirect-me/index.html"))).toBe(false);

  route = {
    ...baseRoute,
    page: {
      ...baseRoute.page,
      loader: () => Promise.reject(new Error("prerender-boom")),
    },
    pattern: "/will-fail",
  };
  manifest = await withBuildStub(() =>
    buildStaticTarget(
      [route, ...scanned.routes.filter((item) => item.mode === "ssg")],
      app.path,
      join(app.path, ".furin/build"),
      scanned.root,
      {
        staticConfig: { onSSR: "skip", outDir: scanned.distDir },
        target: "static",
      },
    ),
  );
  expect(manifest.skippedRoutes).toContain("/will-fail");
  expect(manifest.renderedRoutes).not.toContain("/will-fail");
  buildError = await rejectionError(
    withBuildStub(() =>
      buildStaticTarget(
        [route, ...scanned.routes.filter((item) => item.mode === "ssg")],
        app.path,
        join(app.path, ".furin/build"),
        scanned.root,
        { staticConfig: { outDir: scanned.distDir }, target: "static" },
      ),
    ),
  );
  expect(buildError.message).toMatch(PRERENDER_FAIL_RE);

  const dynamicRoute = scanned.routes.find((item) => item.pattern.includes(":"))!;
  expect(dynamicRoute).toBeDefined();
  patchedRoutes = scanned.routes.map((item) =>
    item.pattern === dynamicRoute.pattern
      ? {
          ...item,
          page: {
            ...item.page,
            staticParams: () => Promise.reject(new Error("staticParams-boom")),
          },
        }
      : item,
  );
  buildError = await rejectionError(
    withBuildStub(() =>
      buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, {
        staticConfig: { outDir: scanned.distDir },
        target: "static",
      }),
    ),
  );
  expect(buildError.message).toMatch(STATIC_EXPORT_RE);
  manifest = await withBuildStub(() =>
    buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), scanned.root, {
      staticConfig: { onSSR: "skip", outDir: scanned.distDir },
      target: "static",
    }),
  );
  expect(manifest.skippedRoutes).toContain(dynamicRoute.pattern);

  const slowRoute = {
    ...baseRoute,
    page: {
      ...baseRoute.page,
      loader: async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { pageData: "slow" };
      },
    },
    pattern: "/z-slow",
  };
  const fastRoute = {
    ...baseRoute,
    page: {
      ...baseRoute.page,
      loader: async () => ({ pageData: "fast" }),
    },
    pattern: "/a-fast",
  };
  manifest = await withBuildStub(() =>
    buildStaticTarget(
      [slowRoute, fastRoute],
      app.path,
      join(app.path, ".furin/build"),
      scanned.root,
      {
        staticConfig: { outDir: scanned.distDir },
        target: "static",
      },
    ),
  );
  expect(manifest.renderedRoutes).toEqual(["/a-fast", "/z-slow"]);
}

function runScenarioWorker(): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(import.meta.path, {
      env: { ...process.env, [RUN_SCENARIOS_ENV]: "1" },
    });
    worker.onmessage = (event: MessageEvent<ScenarioWorkerResult>) => {
      worker.terminate();
      if (event.data.error === null) {
        resolve();
        return;
      }
      reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(event.error ?? new Error(event.message));
    };
  });
}

if (process.env[RUN_SCENARIOS_ENV] === "1") {
  try {
    await runBuildStaticTargetScenarios();
    cleanupTmpApps();
    postMessage({ error: null } satisfies ScenarioWorkerResult);
  } catch (error) {
    cleanupTmpApps();
    postMessage({
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    } satisfies ScenarioWorkerResult);
  }
} else {
  test("buildStaticTarget scenarios", (done) => {
    runScenarioWorker().then(() => done(), done);
  }, 30_000);
}
