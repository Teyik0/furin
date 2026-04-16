/**
 * Tests for the static export adapter.
 *
 * All tests are inside a single describe.serial block because buildStaticTarget
 * calls __setDevMode() and setProductionTemplateContent() — module-level
 * singletons that are not safe to mutate from concurrent describe blocks.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildStaticTarget } from "../src/adapter/static.ts";
import type { BuildAppOptions } from "../src/build/types.ts";
import { __resetCacheState } from "../src/render/cache.ts";
import { scanPages } from "../src/router.ts";
import { createTmpApp } from "./helpers/tmp-app.ts";
import { withBuildStub } from "./helpers/with-build-stub.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const SSR_STATIC_RE = /SSR.*static/i;

// ── Helpers ───────────────────────────────────────────────────────────────────

const tmpApps: Array<{ cleanup: () => void }> = [];

afterEach(() => {
  __resetCacheState();
  while (tmpApps.length > 0) {
    tmpApps.pop()?.cleanup();
  }
});

function makeApp(fixtureName = "cli-app") {
  const app = createTmpApp(fixtureName);
  tmpApps.push(app);
  return app;
}

async function runStaticBuild(fixtureName = "cli-app", extra?: Partial<BuildAppOptions>) {
  const app = makeApp(fixtureName);
  const { root, routes } = await scanPages(join(app.path, "src/pages"));
  const distDir = join(app.path, "dist");

  await withBuildStub(() =>
    buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
      target: "static",
      staticConfig: { outDir: distDir },
      ...extra,
    })
  );
  return { app, distDir };
}

// ── All tests run serially to avoid singleton state races ─────────────────────

describe.serial("buildStaticTarget", () => {
  // ── B1: Tracer bullet ────────────────────────────────────────────────────────

  test("B1: pre-renders SSG root route to dist/index.html", async () => {
    const { distDir } = await runStaticBuild();
    expect(existsSync(join(distDir, "index.html"))).toBe(true);
  });

  // ── B2: nested SSG route ─────────────────────────────────────────────────────

  test("B2: pre-renders /blog/hello-world to dist/blog/hello-world/index.html", async () => {
    const { distDir } = await runStaticBuild();
    // cli-app has blog/[slug].tsx with staticParams: [{ slug: "hello-world" }]
    expect(existsSync(join(distDir, "blog/hello-world/index.html"))).toBe(true);
  });

  // ── B7: 404.html ─────────────────────────────────────────────────────────────

  test("B7: writes 404.html (SPA shell fallback for GitHub Pages)", async () => {
    const { distDir } = await runStaticBuild();
    expect(existsSync(join(distDir, "404.html"))).toBe(true);
  });

  // ── B6: dynamic SSG expands staticParams ─────────────────────────────────────

  test("B6: dynamic SSG with staticParams writes one file per variant", async () => {
    const { distDir } = await runStaticBuild();
    const htmlPath = join(distDir, "blog/hello-world/index.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain("<!DOCTYPE html>");
  });

  // ── B3: SSR + onSSR:"error" (default) → throw ────────────────────────────────

  test("B3: throws when SSR route present and onSSR is 'error' (default)", async () => {
    const app = makeApp("cli-app-ssr");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    await expect(
      withBuildStub(() =>
        buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
          target: "static",
          staticConfig: { outDir: distDir },
        })
      )
    ).rejects.toThrow(SSR_STATIC_RE);
  });

  // ── B9: multiple SSR routes → single error with full list ────────────────────

  test("B9: error message lists ALL non-SSG routes, not just the first", async () => {
    const app = makeApp("cli-app-ssr");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    let errorMsg = "";
    try {
      await withBuildStub(() =>
        buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
          target: "static",
          staticConfig: { outDir: distDir },
        })
      );
    } catch (err) {
      errorMsg = String(err);
    }

    // /dashboard is ssr — must appear in the error
    expect(errorMsg).toContain("/dashboard");
  });

  // ── B4: onSSR:"skip" → no throw, SSR route absent from output ────────────────

  test("B4: skips SSR routes without throwing when onSSR is 'skip'", async () => {
    const app = makeApp("cli-app-ssr");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    // Must NOT throw
    await withBuildStub(() =>
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir, onSSR: "skip" },
      })
    );

    // SSG pages are rendered, SSR dashboard is absent
    expect(existsSync(join(distDir, "index.html"))).toBe(true);
    expect(existsSync(join(distDir, "dashboard/index.html"))).toBe(false);
  });

  // ── B5: dynamic SSG without staticParams → warn + skip ───────────────────────

  test("B5: dynamic SSG route without staticParams is skipped without throwing", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    // Patch out staticParams on the dynamic route
    const patchedRoutes = routes.map((r) =>
      r.pattern.includes(":") ? { ...r, page: { ...r.page, staticParams: undefined } } : r
    );

    // Must NOT throw — just warn and skip
    await withBuildStub(() =>
      buildStaticTarget(patchedRoutes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir },
      })
    );

    expect(existsSync(join(distDir, "index.html"))).toBe(true);
    expect(existsSync(join(distDir, "blog/hello-world/index.html"))).toBe(false);
  });

  // ── B8: basePath → asset paths use the prefixed value ────────────────────────

  test("B8: index.html asset references use basePath prefix when basePath is set", async () => {
    const app = makeApp("cli-app");
    const { root, routes } = await scanPages(join(app.path, "src/pages"));
    const distDir = join(app.path, "dist");

    await withBuildStub(() =>
      buildStaticTarget(routes, app.path, join(app.path, ".furin/build"), root, {
        target: "static",
        staticConfig: { outDir: distDir, basePath: "/furin" },
      })
    );

    const html = readFileSync(join(distDir, "index.html"), "utf8");
    // JS/CSS chunks must reference /furin/_client/ not /_client/
    expect(html).toContain("/furin/_client/");
    expect(html).not.toContain('"/_client/');
  });
});
