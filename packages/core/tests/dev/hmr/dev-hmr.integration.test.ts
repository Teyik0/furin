// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { extractDevClientEntry, getFreePort } from "../../support/hmr.ts";
import { startProcess } from "../../support/process.ts";

const BUN_DEV_CLIENT_ENTRY_PATTERN = /^\/_bun\/client\/index-/;

/**
 * Integration test for the dev-mode HMR pipeline.
 *
 * Verifies:
 * 1. SSR returns correct HTML on first request.
 * 2. After a page file edit, the next request returns FRESH SSR content
 *    (cache-busting via ?t=<timestamp> works).
 * 3. No --hot server restart occurs (no second "listening on" in logs).
 */
describe.serial("dev HMR", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  writeAppFile(
    app.path,
    "src/components/mobile-nav.tsx",
    [
      'import { useState } from "react";',
      "",
      "export function MobileNav() {",
      "  const [open] = useState(true);",
      "  return <button data-open={String(open)}>Mobile nav</button>;",
      "}",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    [
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
      "",
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssr" })',
      "  .layout(({ children }) => (",
      '    <html lang="en">',
      "      <head><HeadContent /></head>",
      '      <body data-root-version="root-v1">{children}<Scripts /></body>',
      "    </html>",
      "));",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/docs/_route.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { MobileNav } from "../../components/mobile-nav";',
      'import { route as rootRoute } from "../root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .layout(({ children }) => (",
      "    <section>",
      "      <MobileNav />",
      "      {children}",
      "    </section>",
      "  ));",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/docs/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as parentRoute } from "./_route";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: parentRoute, mode: "ssg" })',
      "  .page(() => <main>Docs page</main>);",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "isr", revalidate: 60 })',
      "  .page(() => <main>ISR home</main>);",
    ].join("\n")
  );

  beforeAll(async () => {
    port = await getFreePort();
  });

  afterAll(() => {
    server?.kill();
    app.cleanup();
  });

  test("server starts and SSR renders initial content", async () => {
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });

    // Wait for server to be ready (poll with retries)
    let ready = false;
    for (let i = 0; i < 80; i += 1) {
      try {
        const r = await fetch(`http://localhost:${port}/`);
        if (r.ok) {
          ready = true;
          break;
        }
      } catch {
        // not ready yet
      }
      await Bun.sleep(250);
    }
    expect(ready).toBe(true);

    const html = await (await fetch(`http://localhost:${port}/`)).text();
    expect(html).toContain("ISR home");
    expect(html).toContain("__FURIN_DATA__");
    expect(html).toContain('data-furin-entry=""');
    expect(html).not.toContain('id="root"');

    const hmrEntryHtml = await (await fetch(`http://localhost:${port}/_bun_hmr_entry`)).text();
    expect(hmrEntryHtml).toContain("data-bun-dev-server-script");
    expect(extractDevClientEntry(hmrEntryHtml)).toMatch(BUN_DEV_CLIENT_ENTRY_PATTERN);
  }, 30_000);

  test("after file edit, SSR returns updated content (no restart)", async () => {
    // Record logs before edit
    const logsBefore = server.getStdout() + server.getStderr();
    const listenCountBefore = (logsBefore.match(/listening on/g) ?? []).length;

    // Edit the page component
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssg" })',
        "  .page(() => <main>Updated via HMR</main>);",
      ].join("\n")
    );

    // Poll until SSR returns updated content (or timeout after ~10s)
    let html = "";
    for (let i = 0; i < 40; i += 1) {
      html = await (await fetch(`http://localhost:${port}/`)).text();
      if (html.includes("Updated via HMR")) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(html).toContain("Updated via HMR");
    expect(html).not.toContain("Home page");

    // Verify NO additional server restart occurred
    const logsAfter = server.getStdout() + server.getStderr();
    const listenCountAfter = (logsAfter.match(/listening on/g) ?? []).length;

    expect(listenCountAfter).toBe(listenCountBefore);
  }, 15_000);

  test("second edit also produces fresh SSR (repeated cache-busting)", async () => {
    writeAppFile(
      app.path,
      "src/pages/index.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "./root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssg" })',
        "  .page(() => <main>Second edit works</main>);",
      ].join("\n")
    );

    // Poll until SSR reflects the second edit (or timeout after ~10s)
    let html = "";
    for (let i = 0; i < 40; i += 1) {
      html = await (await fetch(`http://localhost:${port}/`)).text();
      if (html.includes("Second edit works")) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(html).toContain("Second edit works");
    expect(html).not.toContain("Updated via HMR");

    // Still no additional restart
    const logs = server.getStdout() + server.getStderr();
    const listenCount = (logs.match(/listening on/g) ?? []).length;
    expect(listenCount).toBe(1);
  }, 15_000);

  test("editing root.tsx keeps nested hook layouts rendering without invalid hook crashes", async () => {
    let response: Response | null = null;
    let html = "";

    for (let i = 0; i < 40; i += 1) {
      response = await fetch(`http://localhost:${port}/docs`);
      html = await response.text();
      if (response.ok && html.includes("root-v1") && html.includes("Mobile nav")) {
        break;
      }
      await Bun.sleep(250);
    }

    expect(response?.status).toBe(200);
    expect(html).toContain("root-v1");
    expect(html).toContain("Mobile nav");
    expect(html).toContain("Docs page");

    writeAppFile(
      app.path,
      "src/pages/root.tsx",
      [
        'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
        "",
        "export const route = defineRootRoute()",
        '  .config({ mode: "ssr" })',
        "  .layout(({ children }) => (",
        '    <html lang="en">',
        "      <head><HeadContent /></head>",
        '      <body data-root-version="root-v2">{children}<Scripts /></body>',
        "    </html>",
        "));",
      ].join("\n")
    );

    let updatedResponse: Response | null = null;
    let updatedHtml = "";
    for (let i = 0; i < 40; i += 1) {
      updatedResponse = await fetch(`http://localhost:${port}/docs`);
      updatedHtml = await updatedResponse.text();
      if (updatedResponse.ok && updatedHtml.includes("root-v2")) {
        break;
      }
      await Bun.sleep(250);
    }

    expect(updatedResponse?.status).toBe(200);
    expect(updatedHtml).toContain("root-v2");
    expect(updatedHtml).toContain("Mobile nav");
    expect(updatedHtml).toContain("Docs page");
    expect(updatedHtml).not.toContain("root-v1");

    const logs = server.getStdout() + server.getStderr();
    expect(logs).not.toContain("Invalid hook call");
    expect(logs).not.toContain("dispatcher is null");
    expect(logs).not.toContain("resolveDispatcher().useState");
    expect(logs).not.toContain(" GET /docs 500 ");
  }, 20_000);

  test("editing an unrelated _route still serves the new dev shell from / (no infinite reload loop)", async () => {
    // Regression: previously the dev ISR cache held the assembled HTML with the
    // OLD client chunk URL embedded. Editing an unrelated _route.tsx rebundled
    // the client (new chunk URL on /_bun_hmr_entry) but the cache kept serving
    // the stale HTML, sending the browser into an infinite reload loop.
    //
    // Fix: dev mode caches loader output (so expensive loaders don't re-run
    // on every refresh) but ALWAYS re-assembles HTML fresh.  The shell
    // template embedded in each response carries the latest Bun client
    // chunk URL, and the loader cache is invalidated source-aware via
    // `isDevLoaderCacheValid` (mtime-checked dependency walk on every
    // read), so a sibling _route.tsx edit drops dependent entries on the
    // very next request.
    const warmHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const initialBundle = extractDevClientEntry(warmHtml);

    expect(initialBundle).not.toBeNull();

    writeAppFile(
      app.path,
      "src/pages/docs/_route.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { MobileNav } from "../../components/mobile-nav";',
        'import { route as rootRoute } from "../root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        "  .layout(({ children }) => (",
        '    <section data-docs-layout="docs-v2">',
        "      <MobileNav />",
        "      {children}",
        "    </section>",
        "  ));",
      ].join("\n")
    );

    // Bun may rebundle multiple times in close succession; instead of pinning to
    // a single intermediate chunk, just assert the served chunk eventually
    // diverges from the stale one captured before the edit. The cache-stale bug
    // would keep `/` pinned on `initialBundle` indefinitely.
    let refreshedHomeChunk: string | null = null;
    let latestHmrShell: string | null = initialBundle;
    for (let i = 0; i < 40; i += 1) {
      const hmrEntryHtml = await (await fetch(`http://localhost:${port}/_bun_hmr_entry`)).text();
      latestHmrShell = extractDevClientEntry(hmrEntryHtml);
      const homeHtml = await (await fetch(`http://localhost:${port}/`)).text();
      refreshedHomeChunk = extractDevClientEntry(homeHtml);
      if (
        latestHmrShell &&
        latestHmrShell !== initialBundle &&
        refreshedHomeChunk &&
        refreshedHomeChunk !== initialBundle
      ) {
        break;
      }
      await Bun.sleep(250);
    }

    expect(latestHmrShell).not.toBe(initialBundle);
    expect(refreshedHomeChunk).not.toBe(initialBundle);
  }, 20_000);
});
