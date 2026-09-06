// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { startProcess } from "../../support/process.ts";

/** Matches `data-stamp="<digits>"` in ISR-rendered HTML. */
const STAMP_ATTR_RE = /data-stamp="(\d+)"/;
/** Matches `data-hello="<word>"` — used by test #9 to assert root-loader propagation. */
const HELLO_ATTR_RE = /data-hello="([^"]+)"/;

/**
 * Integration tests for HMR parent-child dependency edge cases.
 *
 * Each case targets a distinct scenario where a file change in one part of the
 * route hierarchy must (or must not) propagate to another part:
 *
 * #3 (P0): Edit child page `/blog/[slug].tsx` while the parent `/blog` has been
 *   served — the next request to the child must reflect the updated component.
 *
 * #4 (P0): Edit the parent `blog/_route.tsx` while a child request `/blog/hello`
 *   is in flight (or has just been served) — the next SSR response must embed the
 *   new layout and produce no "Invalid hook call" or dispatcher errors.
 *
 * #5 (P1): Editing the parent `_route.tsx` must propagate the updated layout to
 *   BOTH the parent route (`/blog`) AND the child route (`/blog/hello`) on their
 *   respective next SSR cycles — without a server restart.
 *
 * #7 (P0): Editing the loader code inside a child ISR page file MUST
 *   invalidate the dev ISR loader cache for that page on the next request.
 *   Mechanism: `isDevLoaderCacheValid` stat-checks every entry dependency
 *   against `entry.generatedAt` at cache-read time.  No fs watcher needed.
 *
 * #9 (P0): Editing the LOADER in `root.tsx` MUST be reflected on the next
 *   request to any page whose data depends on the root loader.  This is the
 *   same mechanism as #7 but exercises the depth-0 (root) edge of the
 *   dependency chain — the case where the user's actual bug surfaced.
 *
 * Out of scope:
 *   #6 (P1): Client-side SPA prefetch cache invalidation — requires browser
 *     automation (Playwright / Puppeteer) because `prefetchCache` lives in the
 *     browser process.
 *
 * #8 (P2, hot-adding a page file at runtime) is now COVERED by
 * `dev-route-topology.integration.test.ts`: the topology watcher rebuilds the
 * native renderer on route add/remove, so new routes are served without a
 * restart.
 */

async function pollUntil(
  fn: () => Promise<boolean>,
  maxAttempts: number,
  delayMs: number
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i += 1) {
    if (await fn()) {
      return true;
    }
    await Bun.sleep(delayMs);
  }
  return false;
}

// ── Shared app fixture ─────────────────────────────────────────────────────
// All tests share one running server so startup cost is paid once.
// Tests are serial and build on each other's state (layout version bumps).

describe.serial("dev HMR — parent/child dependency edge cases", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  // Root layout (minimal — only wraps content with a root marker).
  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    [
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
      "",
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssr" })',
      '  .layout(({ children }) => <html lang="en"><head><HeadContent /></head><body><div data-root="true">{children}</div><Scripts /></body></html>);',
    ].join("\n")
  );

  // Blog section: parent layout with a versioned marker.
  writeAppFile(
    app.path,
    "src/pages/blog/_route.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "../root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      '  .layout(({ children }) => <nav data-blog-layout="blog-v1">{children}</nav>);',
    ].join("\n")
  );

  // Blog listing page (parent route: /blog).
  writeAppFile(
    app.path,
    "src/pages/blog/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as parentRoute } from "./_route";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: parentRoute, mode: "ssg" })',
      '  .page(() => <main data-blog-listing="true">Blog listing</main>);',
    ].join("\n")
  );

  // Blog post page (child route: /blog/[slug]).
  writeAppFile(
    app.path,
    "src/pages/blog/[slug].tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { t } from "elysia";',
      'import { route as parentRoute } from "./_route";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: parentRoute, mode: "ssg", params: t.Object({ slug: t.String() }) })',
      "  .page(() => (",
      '    <article data-post-version="post-v1">Blog post content</article>',
      "  ));",
    ].join("\n")
  );

  // ISR page with timestamp loader — used only by test #7.
  writeAppFile(
    app.path,
    "src/pages/blog/isr-stamp.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as parentRoute } from "./_route";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: parentRoute, mode: "isr", revalidate: 60 })',
      "  .loader(async () => ({ stamp: Date.now() }))",
      "  .page(({ data }) => (",
      "    <div data-stamp={String(data.stamp)}>ISR stamp: {data.stamp}</div>",
      "  ));",
    ].join("\n")
  );

  // Home page — needed so the app boots without errors on /.
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssg" })',
      "  .page(() => <main>Home</main>);",
    ].join("\n")
  );

  beforeAll(async () => {
    port = await getFreePort();
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });

    const ready = await pollUntil(
      async () => {
        try {
          const r = await fetch(`http://localhost:${port}/blog`);
          return r.ok;
        } catch {
          return false;
        }
      },
      80,
      250
    );
    if (!ready) {
      throw new Error(`Server failed to start on port ${port}. stderr:\n${server.getStderr()}`);
    }
  }, 30_000);

  afterAll(() => {
    server?.kill();
    app.cleanup();
  });

  // ── #3 (P0) ───────────────────────────────────────────────────────────────

  /**
   * Editing `/blog/[slug].tsx` while the parent `/blog` has been served must
   * produce fresh child content on the next child request.
   *
   * Mechanism: SSR imports page modules via `?furin-server&t=<ts>`.  A new
   * timestamp is generated on each request, so Bun always evaluates the latest
   * on-disk file — no stale child component is possible after an edit.
   */
  test("#3 — editing /blog/[slug].tsx serves fresh child content on next child request", async () => {
    // Warm the parent route first (simulates user browsing /blog).
    const parentRes = await fetch(`http://localhost:${port}/blog`);
    expect(parentRes.status).toBe(200);
    const parentHtml = await parentRes.text();
    expect(parentHtml).toContain('data-blog-listing="true"');

    // Confirm child is on post-v1.
    const child1Res = await fetch(`http://localhost:${port}/blog/hello`);
    expect(child1Res.status).toBe(200);
    const child1Html = await child1Res.text();
    expect(child1Html).toContain('data-post-version="post-v1"');

    // Edit the child page — bump version to post-v2.
    writeAppFile(
      app.path,
      "src/pages/blog/[slug].tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { t } from "elysia";',
        'import { route as parentRoute } from "./_route";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: parentRoute, mode: "ssg", params: t.Object({ slug: t.String() }) })',
        "  .page(() => (",
        '    <article data-post-version="post-v2">Updated blog post</article>',
        "  ));",
      ].join("\n")
    );

    // Poll until the child route reflects the edit.
    let childHtmlAfter = "";
    const updated = await pollUntil(
      async () => {
        const r = await fetch(`http://localhost:${port}/blog/hello`);
        childHtmlAfter = await r.text();
        return childHtmlAfter.includes('data-post-version="post-v2"');
      },
      40,
      250
    );

    expect(updated).toBe(true);
    expect(childHtmlAfter).toContain('data-post-version="post-v2"');
    expect(childHtmlAfter).not.toContain('data-post-version="post-v1"');

    const logs = server.getStdout() + server.getStderr();
    expect(logs).not.toContain("Invalid hook call");
  }, 20_000);

  // ── #4 (P0) ───────────────────────────────────────────────────────────────

  /**
   * Editing `/blog/_route.tsx` while a child page has just been served must
   * refresh the layout on the next child request without any React hook
   * violations or dispatcher errors.
   *
   * The dangerous scenario: the parent layout component changes identity (new
   * module evaluation), but child pages hold a stale import of `_route.tsx`.
   * Bun's `?t=<ts>` mechanism re-imports `_route.tsx` from disk on the next
   * child request, so both parent and child use the same, current React module
   * graph — hooks stay valid.
   */
  test("#4 — editing /blog/_route.tsx refreshes the layout on child requests, no Invalid hook call", async () => {
    // Confirm baseline: child is rendered inside blog-v1 layout.
    let html1 = "";
    const baselineOk = await pollUntil(
      async () => {
        const r = await fetch(`http://localhost:${port}/blog/hello`);
        html1 = await r.text();
        return r.ok && html1.includes('data-blog-layout="blog-v1"');
      },
      20,
      250
    );
    expect(baselineOk).toBe(true);
    expect(html1).toContain('data-blog-layout="blog-v1"');

    // Edit the parent layout — bump to blog-v2.
    writeAppFile(
      app.path,
      "src/pages/blog/_route.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "../root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        '  .layout(({ children }) => <nav data-blog-layout="blog-v2">{children}</nav>);',
      ].join("\n")
    );

    // Poll until the child route reflects blog-v2.
    let childHtmlAfter = "";
    const childUpdated = await pollUntil(
      async () => {
        const r = await fetch(`http://localhost:${port}/blog/hello`);
        childHtmlAfter = await r.text();
        return childHtmlAfter.includes('data-blog-layout="blog-v2"');
      },
      40,
      250
    );

    expect(childUpdated).toBe(true);
    expect(childHtmlAfter).toContain('data-blog-layout="blog-v2"');
    expect(childHtmlAfter).not.toContain('data-blog-layout="blog-v1"');

    // No React hook violation must appear in server logs.
    const logs = server.getStdout() + server.getStderr();
    expect(logs).not.toContain("Invalid hook call");
    expect(logs).not.toContain("dispatcher is null");
    expect(logs).not.toContain("resolveDispatcher().useState");
  }, 20_000);

  // ── #5 (P1) ───────────────────────────────────────────────────────────────

  /**
   * After editing the parent `_route.tsx`, BOTH the parent route (`/blog`) AND
   * the child route (`/blog/hello`) must embed the updated layout in their next
   * SSR response — without a server restart.
   *
   * This validates that layout inheritance propagates through the route chain
   * on every request, not just on the directly-requested route.
   */
  test("#5 — parent layout update propagates to both /blog and /blog/[slug] on next SSR", async () => {
    // Edit parent layout to blog-v3 (v2 was set in #4 above).
    writeAppFile(
      app.path,
      "src/pages/blog/_route.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "../root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        '  .layout(({ children }) => <nav data-blog-layout="blog-v3">{children}</nav>);',
      ].join("\n")
    );

    const logsBefore = server.getStdout() + server.getStderr();
    const listenCountBefore = (logsBefore.match(/listening on/g) ?? []).length;

    // Poll until BOTH the parent listing and a child post reflect blog-v3.
    let parentHtml = "";
    let childHtml = "";
    const bothUpdated = await pollUntil(
      async () => {
        const [pr, cr] = await Promise.all([
          fetch(`http://localhost:${port}/blog`),
          fetch(`http://localhost:${port}/blog/hello`),
        ]);
        parentHtml = await pr.text();
        childHtml = await cr.text();
        return (
          parentHtml.includes('data-blog-layout="blog-v3"') &&
          childHtml.includes('data-blog-layout="blog-v3"')
        );
      },
      40,
      250
    );

    expect(bothUpdated).toBe(true);
    expect(parentHtml).toContain('data-blog-layout="blog-v3"');
    expect(childHtml).toContain('data-blog-layout="blog-v3"');

    // Layout must NOT still show v2 or v1 in either response.
    expect(parentHtml).not.toContain('data-blog-layout="blog-v2"');
    expect(childHtml).not.toContain('data-blog-layout="blog-v2"');

    // No server restart must have occurred.
    const logsAfter = server.getStdout() + server.getStderr();
    const listenCountAfter = (logsAfter.match(/listening on/g) ?? []).length;
    expect(listenCountAfter).toBe(listenCountBefore);
  }, 20_000);

  // ── #7 (P0) ───────────────────────────────────────────────────────────────

  /**
   * Editing the loader inside an ISR page file MUST invalidate the dev ISR
   * loader cache before the next request reads it.
   *
   * Mechanism — pre-read dependency mtime check (`isDevLoaderCacheValid`):
   *   • Each cache entry stores `dependencies: string[]` (page + every
   *     `_route.tsx` between page and pages root + `root.tsx`).
   *   • At cache-read time, every dep is `statSync`-ed and its `mtimeMs` is
   *     compared to `entry.generatedAt`.  If any dep has been edited since
   *     the entry was written, the entry is considered invalid and the
   *     loader chain re-runs.
   *
   * No fs watcher, no shared mtime map, no reliance on plugin onLoad order —
   * a fresh `statSync` on the request hot path is the source of truth.
   *
   * Public-interface assertion: after editing the loader to return a stamp
   * bumped by 99999, the next request MUST embed a stamp ≥ stamp1 + 99999.
   * A cache hit would give stamp2 === stamp1 (the old value).
   */
  test("#7 — editing an ISR page file invalidates the dev loader cache via mtime check", async () => {
    // Step 1: warm the ISR loader cache for /blog/isr-stamp.
    let html1 = "";
    const ready = await pollUntil(
      async () => {
        try {
          const r = await fetch(`http://localhost:${port}/blog/isr-stamp`);
          if (!r.ok) {
            return false;
          }
          html1 = await r.text();
          return html1.includes("data-stamp");
        } catch {
          return false;
        }
      },
      40,
      250
    );
    expect(ready).toBe(true);

    const stamp1 = html1.match(STAMP_ATTR_RE)?.[1];
    expect(stamp1).toBeDefined();

    // Step 2: wait long enough for Date.now() to advance so that a fresh
    // loader call would produce a strictly greater stamp.
    await Bun.sleep(30);

    // Step 3: edit the page file — the new loader returns Date.now() + 99999,
    // which is unambiguously different from the original stamp.
    writeAppFile(
      app.path,
      "src/pages/blog/isr-stamp.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as parentRoute } from "./_route";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: parentRoute, mode: "isr", revalidate: 60 })',
        "  // Loader intentionally returns a bumped stamp so a cache miss is detectable.",
        "  .loader(async () => ({ stamp: Date.now() + 99999 }))",
        "  .page(({ data }) => (",
        "    <div data-stamp={String(data.stamp)}>ISR stamp v2: {data.stamp}</div>",
        "  ));",
      ].join("\n")
    );

    // Step 4: request #2 — at cache-read time, `isDevLoaderCacheValid`
    // stat-checks every dependency in the entry against `entry.generatedAt`.
    // The page file's mtime is now newer than `generatedAt` (we just edited
    // it), so the entry is treated as invalid and the loader chain re-runs.
    // The new loader returns `Date.now() + 99999`, unambiguously ≥ stamp1 + 99999.
    const res2 = await fetch(`http://localhost:${port}/blog/isr-stamp`);
    expect(res2.status).toBe(200);
    const html2 = await res2.text();
    const stamp2 = html2.match(STAMP_ATTR_RE)?.[1];
    expect(stamp2).toBeDefined();

    // Cache hit would produce stamp2 === stamp1.  The mtime-driven validity
    // check forces a miss, so stamp2 must reflect the bumped loader.
    expect(Number(stamp2)).toBeGreaterThanOrEqual(Number(stamp1) + 99_999);
  }, 25_000);

  // ── #9 (P0) — root.tsx loader edits propagate ─────────────────────────────

  /**
   * Editing the LOADER in `root.tsx` MUST be reflected on the next request
   * to any page whose data depends on the root loader.  This is the
   * exact scenario that surfaced the user's bug:
   *
   *   1. `root.tsx` exports `loader: () => ({ hello: "v1" })`.
   *   2. Page renders `<div data-hello={hello}>` from props.
   *   3. First request → cache populated with `{ hello: "v1" }`.
   *   4. User edits `root.tsx` → loader returns `{ hello: "v2" }`.
   *   5. Second request → MUST embed `data-hello="v2"`.
   *
   * Without `isDevLoaderCacheValid`, step 5 served stale data because
   * `root.tsx` is at depth 0 of the dependency chain — neither the page
   * file's `?furin-server` namespace `onLoad` nor `--hot`'s eager
   * invalidation reliably flushed the cache before the next read.
   *
   * Public-interface assertion: `data-hello` swaps from "v1" → "v2"
   * across the edit, with the same page URL.  No restart, no reload of
   * the dev server.
   */
  test("#9 — editing root.tsx loader propagates to ISR pages on next request", async () => {
    // Helper — build a root.tsx whose loader contributes `hello: <value>`.
    // The layout renders `data-hello` on every response so we can assert
    // against any registered page.
    const writeRoot = (helloValue: string): void => {
      writeAppFile(
        app.path,
        "src/pages/root.tsx",
        [
          'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
          "",
          "export const route = defineRootRoute()",
          '  .config({ mode: "ssr" })',
          `  .loader(() => ({ hello: "${helloValue}" }))`,
          "  .layout(({ children, data }) => (",
          '    <html lang="en">',
          "      <head><HeadContent /></head>",
          '      <body data-root="true" data-hello={data.hello}>',
          "        {children}",
          "        <Scripts />",
          "      </body>",
          "    </html>",
          "  ));",
        ].join("\n")
      );
    };

    // Rewarm the ISR cache so the entry is fresh for the mtime-check
    // code path we want to exercise.  Without this, the 60 s TTL from
    // test #7 may have expired by the time this test runs, turning the
    // intended cache-hit-into-mtime-invalidation into a plain miss.
    const warmRes = await fetch(`http://localhost:${port}/blog/isr-stamp`);
    expect(warmRes.status).toBe(200);

    // Step 1: bump root.tsx to v1.  Bun --hot picks the change up
    // asynchronously; we poll the next request until the new layout
    // (with `data-hello`) shows up.
    writeRoot("v1");

    let html1 = "";
    const ready = await pollUntil(
      async () => {
        try {
          // /blog/isr-stamp is registered at startup, has mode: "isr", and
          // its existing cache from test #7 forces the dependency-mtime
          // check (`isDevLoaderCacheValid`) to fire — the exact code path
          // we want to exercise.
          const r = await fetch(`http://localhost:${port}/blog/isr-stamp`);
          if (!r.ok) {
            return false;
          }
          html1 = await r.text();
          return html1.match(HELLO_ATTR_RE)?.[1] === "v1";
        } catch {
          return false;
        }
      },
      40,
      250
    );
    expect(ready).toBe(true);

    const hello1 = html1.match(HELLO_ATTR_RE)?.[1];
    expect(hello1).toBe("v1");

    // Sleep so the next mtime is strictly greater than the current
    // entry's `generatedAt` — APFS sub-millisecond resolution makes this
    // virtually instant, but we want zero timing ambiguity.
    await Bun.sleep(20);

    // Step 2: edit root.tsx — loader now returns hello: "v2".
    writeRoot("v2");

    // Step 3: the next request MUST observe `data-hello="v2"`.
    // Failure mode (= the user's bug) is a cache hit serving stale data,
    // so `data-hello` would stay "v1".  We poll briefly to give Bun --hot
    // time to settle the workspace re-evaluation, but the assertion is
    // unconditional: `v2` is the only acceptable result.
    let html2 = "";
    await pollUntil(
      async () => {
        try {
          const r = await fetch(`http://localhost:${port}/blog/isr-stamp`);
          if (!r.ok) {
            return false;
          }
          html2 = await r.text();
          return html2.match(HELLO_ATTR_RE)?.[1] === "v2";
        } catch {
          return false;
        }
      },
      20,
      250
    );

    const hello2 = html2.match(HELLO_ATTR_RE)?.[1];
    expect(hello2).toBe("v2");
  }, 25_000);
});
