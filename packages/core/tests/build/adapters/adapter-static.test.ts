import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeTargetApp } from "../../../src/adapter/runtime-build.ts";
import { buildStaticTarget } from "../../../src/adapter/static.ts";
import type { BuildAppOptions } from "../../../src/build/types.ts";
import { scanPages } from "../../../src/server/router/discovery.ts";
import type { ResolvedRoute, RootLayout } from "../../../src/server/router/types.ts";
import { parseDeferredNdjson } from "../../../src/shared/deferred-ndjson.ts";
import { createTmpApp, type TmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { withBuildStub } from "../../support/with-build-stub.ts";

const SSR_STATIC_RE = /SSR.*static/i;
const BASEPATH_RE = /basePath must start with/;
const UNSAFE_DIR_RE = /unsafe to delete/;
const PRERENDER_FAIL_RE = /route\(s\) failed to pre-render/;
const REQUEST_LOADER_STATIC_RE = /requestLoader.*static/i;
const STATIC_EXPORT_RE = /cannot be statically exported/i;
const BUILD_TIMEOUT_MS = 60_000;
const tmpApps: TmpApp[] = [];

afterEach(() => {
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

function makeApp(fixtureName: string): TmpApp {
  const app = createTmpApp(fixtureName);
  tmpApps.push(app);
  return app;
}

/** An SSG page module, keyed by `id`, whose builder chain continues with `chain`. */
function ssgPage(id: string, chain: string): string {
  return [
    'import { defineRoute } from "@teyik0/furin";',
    `export const route = defineRoute(${JSON.stringify(id)})`,
    '  .config({ mode: "ssg" })',
    `  ${chain};`,
    "",
  ].join("\n");
}

function redirectPage(id: string, location: string): string {
  return ssgPage(
    id,
    `.loader(async () => { throw new Response(null, { headers: { Location: ${JSON.stringify(location)} }, status: 302 }); })
  .page(() => <main>redirect</main>)`
  );
}

async function scanApp(app: TmpApp): Promise<RuntimeTargetApp> {
  const pagesDir = join(app.path, "src/pages");
  const { root, routes } = await scanPages(pagesDir);
  return { pagesDir, prefix: "", root, routes };
}

async function exportApp(app: TmpApp, staticConfig: BuildAppOptions["staticConfig"]) {
  const scanned = await scanApp(app);
  return withBuildStub(() =>
    buildStaticTarget(scanned, app.path, join(app.path, ".furin/build"), {
      staticConfig: { outDir: join(app.path, "dist"), ...staticConfig },
      target: "static",
    })
  );
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
    }
  );
}

async function readNavigationData(path: string) {
  return await parseDeferredNdjson(new Blob([readFileSync(path, "utf8")]).stream(), undefined);
}

describe("static export validation", () => {
  const root: RootLayout = { path: "/root.tsx", route: { __type: "FURIN_ROUTE" } };
  const requestRouteEntry = {
    __type: "FURIN_ROUTE",
    requestLoader: async () => ({ userId: "private" }),
  } satisfies RootLayout["route"];
  const requestRoute: ResolvedRoute = {
    mode: "ssg",
    page: { __type: "FURIN_PAGE", _route: requestRouteEntry, component: () => null },
    path: "/index.tsx",
    pattern: "/",
    routeChain: [requestRouteEntry],
    segmentBoundaries: [],
  };
  const mixedLayout: RootLayout["route"] = {
    __type: "FURIN_ROUTE",
    mode: "ssr",
    loader: ({ request }) => ({ session: (request as Request).headers.get("cookie") }),
  };
  const mixedRoute: ResolvedRoute = {
    ...requestRoute,
    page: { ...requestRoute.page, _route: { __type: "FURIN_ROUTE" } },
    routeChain: [mixedLayout],
  };

  function exportRoutes(routes: ResolvedRoute[], rootLayout: RootLayout): Promise<Error> {
    return rejectionError(
      buildStaticTarget(
        { pagesDir: "/", prefix: "", root: rootLayout, routes },
        "/tmp/furin-static-test",
        "/tmp/furin-static-test/.build",
        { target: "static" }
      )
    );
  }

  test("rejects request loaders on pages and on the root layout", async () => {
    expect((await exportRoutes([requestRoute], root)).message).toMatch(REQUEST_LOADER_STATIC_RE);
    const requestRoot = {
      ...root,
      route: { ...root.route, requestLoader: async () => ({ userId: "private" }) },
    };
    expect((await exportRoutes([], requestRoot)).message).toMatch(REQUEST_LOADER_STATIC_RE);
  });

  test("rejects SSG pages below SSR or ISR layouts", async () => {
    expect((await exportRoutes([mixedRoute], root)).message).toContain("ssr layout");
    const isrRoute = { ...mixedRoute, routeChain: [{ ...mixedLayout, mode: "isr" as const, revalidate: 5 }] };
    expect((await exportRoutes([isrRoute], root)).message).toContain("mode: isr");
  });

  test("rejects a basePath without a leading slash", async () => {
    const app = makeApp("cli-app");
    const error = await rejectionError(exportApp(app, { basePath: "sub-path" }));
    expect(error.message).toMatch(BASEPATH_RE);
  });

  test("rejects output directories that are unsafe to delete", async () => {
    const app = makeApp("cli-app");
    for (const outDir of ["/", "C:\\", app.path, join(app.path, "..")]) {
      const error = await rejectionError(exportApp(app, { outDir }));
      expect(error.message).toMatch(UNSAFE_DIR_RE);
    }
  });
});

describe("static export output", () => {
  test(
    "writes SSG pages, their navigation data and the 404 shell",
    async () => {
      const app = makeApp("cli-app");
      await exportApp(app, {});
      const distDir = join(app.path, "dist");

      expect(existsSync(join(distDir, "index.html"))).toBe(true);
      expect(existsSync(join(distDir, "404.html"))).toBe(true);
      expect(readFileSync(join(distDir, "blog/hello-world/index.html"), "utf8")).toContain(
        "<!DOCTYPE html>"
      );
      expect(existsSync(join(distDir, "__furin_data.ndjson"))).toBe(true);
      const parsed = await readNavigationData(join(distDir, "blog/hello-world/__furin_data.ndjson"));
      expect(parsed.syncData).toBeInstanceOf(Object);
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "rejects SSR routes unless onSSR is skip",
    async () => {
      const app = makeApp("cli-app-ssr");
      const error = await rejectionError(exportApp(app, {}));
      expect(error.message).toMatch(SSR_STATIC_RE);
      expect(error.message).toMatch("/dashboard");

      await exportApp(app, { onSSR: "skip" });
      expect(existsSync(join(app.path, "dist/index.html"))).toBe(true);
      expect(existsSync(join(app.path, "dist/dashboard/index.html"))).toBe(false);
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "rejects dynamic routes without staticParams() unless onSSR is skip",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(
        app.path,
        "src/pages/blog/[slug].tsx",
        ssgPage("/blog/[slug]", ".page(() => <article>Blog post page</article>)")
      );
      const error = await rejectionError(exportApp(app, {}));
      expect(error.message).toMatch(STATIC_EXPORT_RE);

      await exportApp(app, { onSSR: "skip" });
      expect(existsSync(join(app.path, "dist/index.html"))).toBe(true);
      expect(existsSync(join(app.path, "dist/blog/hello-world/index.html"))).toBe(false);
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "prefixes client assets with the basePath",
    async () => {
      const app = makeApp("cli-app");
      for (const basePath of ["/furin", "/furin/"]) {
        await exportApp(app, { basePath });
        const html = readFileSync(join(app.path, "dist/index.html"), "utf8");
        expect(html).toContain("/furin/_client/");
        expect(html).not.toContain('"/_client/');
        expect(html).not.toContain("/furin//_client/");
      }
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "orders rendered routes deterministically",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(
        app.path,
        "src/pages/z-slow.tsx",
        ssgPage(
          "/z-slow",
          `.loader(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); return { pageData: "slow" }; })
  .page(() => <main>slow</main>)`
        )
      );
      writeAppFile(
        app.path,
        "src/pages/a-fast.tsx",
        ssgPage("/a-fast", '.loader(async () => ({ pageData: "fast" })).page(() => <main>fast</main>)')
      );

      const manifest = await exportApp(app, {});
      expect(manifest.renderedRoutes).toEqual(["/", "/a-fast", "/blog/hello-world", "/z-slow"]);
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "never lets staticParams() overwrite a more specific route",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(
        app.path,
        "src/pages/about.tsx",
        ssgPage("/about", '.loader(async () => ({ owner: "static-about" })).page(() => <main>about</main>)')
      );
      writeAppFile(
        app.path,
        "src/pages/[slug].tsx",
        ssgPage(
          "/[slug]",
          `.loader(async ({ params }) => ({ owner: \`slug-\${params.slug}\` }))
  .staticParams(() => [{ slug: "about" }, { slug: "other" }])
  .page(() => <main>slug</main>)`
        )
      );

      const manifest = await exportApp(app, {});
      expect(manifest.renderedRoutes).toEqual(["/", "/about", "/blog/hello-world", "/other"]);
      const aboutData = readFileSync(join(app.path, "dist/about/__furin_data.ndjson"), "utf8");
      expect(aboutData).toContain("static-about");
      expect(aboutData).not.toContain("slug-about");
    },
    BUILD_TIMEOUT_MS
  );
});

describe("static export redirects", () => {
  test(
    "exports same-origin redirects below the basePath",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(app.path, "src/pages/redirect-me.tsx", redirectPage("/redirect-me", "/home"));
      writeAppFile(
        app.path,
        "src/pages/absolute-redirect.tsx",
        redirectPage("/absolute-redirect", "http://localhost/home?from=redirect#content")
      );

      const manifest = await exportApp(app, { basePath: "/furin" });
      expect(manifest.renderedRoutes).toContain("/redirect-me");
      expect(manifest.skippedRoutes).not.toContain("/redirect-me");
      const redirectHtml = readFileSync(join(app.path, "dist/redirect-me/index.html"), "utf8");
      expect(redirectHtml).toContain('http-equiv="refresh"');
      expect(redirectHtml).toContain('content="0;url=/furin/home"');
      expect(redirectHtml).toContain('href="/furin/home"');
      const parsedRedirect = await readNavigationData(
        join(app.path, "dist/redirect-me/__furin_data.ndjson")
      );
      expect(parsedRedirect.syncData).toEqual({ __furinRedirect: "/home" });

      const absoluteHtml = readFileSync(join(app.path, "dist/absolute-redirect/index.html"), "utf8");
      expect(absoluteHtml).toContain('content="0;url=/furin/home?from=redirect#content"');
      expect(absoluteHtml).not.toContain("http://localhost");
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "resolves relative, prefixed and external redirects and skips unsafe ones",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(app.path, "src/pages/relative-redirect.tsx", redirectPage("/relative-redirect", "home"));
      writeAppFile(
        app.path,
        "src/pages/prefixed-redirect.tsx",
        redirectPage("/prefixed-redirect", "/furin?from=redirect#content")
      );
      writeAppFile(
        app.path,
        "src/pages/external-redirect.tsx",
        redirectPage("/external-redirect", "https://example.com/away?from=furin#content")
      );
      writeAppFile(app.path, "src/pages/unsafe-redirect.tsx", redirectPage("/unsafe-redirect", "javascript:alert(1)"));

      const manifest = await exportApp(app, { basePath: "/furin", onSSR: "skip" });
      const html = (path: string) => readFileSync(join(app.path, "dist", path, "index.html"), "utf8");
      expect(html("relative-redirect")).toContain('content="0;url=/furin/home"');
      expect(html("prefixed-redirect")).toContain('content="0;url=/furin?from=redirect#content"');
      expect(html("external-redirect")).toContain(
        'content="0;url=https://example.com/away?from=furin#content"'
      );
      expect(manifest.renderedRoutes).toEqual(
        expect.arrayContaining(["/relative-redirect", "/prefixed-redirect", "/external-redirect"])
      );
      expect(manifest.skippedRoutes).toContain("/unsafe-redirect");
      expect(existsSync(join(app.path, "dist/unsafe-redirect/index.html"))).toBe(false);
    },
    BUILD_TIMEOUT_MS
  );
});

describe("static export failures", () => {
  test(
    "skips pages whose render fails only when onSSR is skip",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(
        app.path,
        "src/pages/will-fail.tsx",
        ssgPage(
          "/will-fail",
          '.loader(async () => { throw new Error("prerender-boom"); }).page(() => <main>never</main>)'
        )
      );

      const manifest = await exportApp(app, { onSSR: "skip" });
      expect(manifest.skippedRoutes).toContain("/will-fail");
      expect(manifest.renderedRoutes).not.toContain("/will-fail");

      const error = await rejectionError(exportApp(app, {}));
      expect(error.message).toMatch(PRERENDER_FAIL_RE);
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "skips routes whose staticParams() throws only when onSSR is skip",
    async () => {
      const app = makeApp("cli-app");
      writeAppFile(
        app.path,
        "src/pages/blog/[slug].tsx",
        ssgPage(
          "/blog/[slug]",
          `.staticParams(() => Promise.reject(new Error("staticParams-boom")))
  .page(() => <article>Blog post page</article>)`
        )
      );

      const error = await rejectionError(exportApp(app, {}));
      expect(error.message).toMatch(STATIC_EXPORT_RE);

      const manifest = await exportApp(app, { onSSR: "skip" });
      expect(manifest.skippedRoutes).toContain("/blog/:slug");
    },
    BUILD_TIMEOUT_MS
  );

  test(
    "keeps the previous export when the new one fails",
    async () => {
      const app = makeApp("cli-app");
      const failFlag = join(app.path, "fail.flag");
      writeAppFile(
        app.path,
        "src/pages/flaky.tsx",
        ssgPage(
          "/flaky",
          `.loader(async () => { if (await Bun.file(${JSON.stringify(failFlag)}).exists()) throw new Error("boom"); return {}; })
  .page(() => <main>flaky page</main>)`
        )
      );
      await exportApp(app, {});
      writeFileSync(failFlag, "");

      expect((await rejectionError(exportApp(app, {}))).message).toMatch(PRERENDER_FAIL_RE);
      expect(readFileSync(join(app.path, "dist/flaky/index.html"), "utf8")).toContain("flaky page");
      expect(existsSync(join(app.path, ".furin/build/static"))).toBe(false);
    },
    BUILD_TIMEOUT_MS
  );
});
