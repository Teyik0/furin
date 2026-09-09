// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { extractDevClientEntry, getFreePort } from "../../support/hmr.ts";
import { startProcess } from "../../support/process.ts";

/**
 * Regression test for issue: editing a `_route.tsx` in a sibling subdirectory
 * (one that is NOT a dependency of the currently-cached page) used to leave
 * the ISR/SSG cache untouched on the next request. The browser then loaded
 * the cached HTML which embedded the OLD client chunk URL, while Bun had
 * already rebundled and was serving a NEW chunk URL on `/_bun_hmr_entry`.
 *
 * The browser's HMR client reacts to the chunk-URL mismatch by triggering a
 * full reload — and because the cache keeps serving the same stale HTML, the
 * reload loops indefinitely.
 *
 * This test reproduces the precise scenario:
 *   1. ISR home at `/` is rendered + cached on first visit.
 *   2. An unrelated `pages/sub/_route.tsx` is edited.
 *   3. Bun rebundles; the `_bun_hmr_entry` chunk URL flips.
 *   4. On the next visit to `/`, the served HTML MUST embed the new chunk URL.
 */

describe.serial("dev HMR cache invalidation on unrelated _route edit", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  writeAppFile(
    app.path,
    "src/pages/root.tsx",
    [
      'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
      "",
      "export const route = defineRootRoute()",
      '  .config({ mode: "ssr" })',
      '  .layout(({ children }) => <html lang="en"><head><HeadContent /></head><body><div data-test="root">{children}</div><Scripts /></body></html>);',
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
      "  .page(() => <main>ISR home page</main>);",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/sub/_route.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "../root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      '  .layout(({ children }) => <section data-test="sub-v1">{children}</section>);',
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/sub/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as parentRoute } from "./_route";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: parentRoute, mode: "ssg" })',
      "  .page(() => <main>Sub page</main>);",
    ].join("\n")
  );

  beforeAll(async () => {
    port = await getFreePort();
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });

    // Wait for server to come up.
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
    if (!ready) {
      throw new Error(`server failed to start on port ${port}`);
    }
  });

  afterAll(() => {
    server?.kill();
    app.cleanup();
  });

  test("editing pages/sub/_route.tsx invalidates the cached ISR home page so the next reload embeds the fresh chunk URL", async () => {
    // Step 1: warm the ISR cache for `/` and capture the initial chunk URL.
    const warmHtml = await (await fetch(`http://localhost:${port}/`)).text();
    const initialChunk = extractDevClientEntry(warmHtml);
    expect(initialChunk).not.toBeNull();

    // Step 2: edit pages/sub/_route.tsx — an unrelated layout (NOT a dependency of `/`).
    writeAppFile(
      app.path,
      "src/pages/sub/_route.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { route as rootRoute } from "../root";',
        "",
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "ssr" })',
        '  .layout(({ children }) => <section data-test="sub-v2">{children}</section>);',
      ].join("\n")
    );

    // Step 3: wait for Bun to rebundle — `/_bun_hmr_entry` should flip to a new chunk URL.
    let latestShellChunk: string | null = initialChunk;
    for (let i = 0; i < 40; i += 1) {
      const hmrHtml = await (await fetch(`http://localhost:${port}/_bun_hmr_entry`)).text();
      latestShellChunk = extractDevClientEntry(hmrHtml);
      if (latestShellChunk && latestShellChunk !== initialChunk) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(latestShellChunk).not.toBeNull();
    expect(latestShellChunk).not.toBe(initialChunk);

    // Step 4: hit `/` again. The served HTML MUST embed the new chunk URL.
    // Without the fix, the ISR cache keeps serving the stale HTML with the
    // old chunk URL, and the browser ends up in an infinite reload loop.
    //
    // Re-read `/_bun_hmr_entry` on every iteration: on slow CI runners Bun can
    // rebuild several times during this loop, so we must compare the home
    // page's chunk URL against the *current* shell chunk, not a captured one.
    let homeHtmlAfter = "";
    let homeChunkAfter: string | null = null;
    let currentShellChunk: string | null = latestShellChunk;
    for (let i = 0; i < 40; i += 1) {
      homeHtmlAfter = await (await fetch(`http://localhost:${port}/`)).text();
      homeChunkAfter = extractDevClientEntry(homeHtmlAfter);
      const hmrHtml = await (await fetch(`http://localhost:${port}/_bun_hmr_entry`)).text();
      currentShellChunk = extractDevClientEntry(hmrHtml);
      if (
        homeChunkAfter !== null &&
        homeChunkAfter === currentShellChunk &&
        homeChunkAfter !== initialChunk
      ) {
        break;
      }
      await Bun.sleep(250);
    }

    expect(homeHtmlAfter).toContain("ISR home page");
    expect(homeChunkAfter).toBe(currentShellChunk);
    expect(homeChunkAfter).not.toBe(initialChunk);
  }, 20_000);
});
