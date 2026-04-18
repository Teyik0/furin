import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { join } from "node:path";
import { startProcess } from "./helpers/run-cli.ts";
import { createTmpApp, writeAppFile } from "./helpers/tmp-app.ts";

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, () => {
      const addr = srv.address();
      srv.close(() => resolve((addr as { port: number }).port));
    });
    srv.on("error", reject);
  });
}

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
      'import { createRoute } from "@teyik0/furin/client";',
      "",
      "export const route = createRoute({",
      '  layout: ({ children }) => <div data-root-version="root-v1">{children}</div>,',
      "});",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/docs/_route.tsx",
    [
      'import { createRoute } from "@teyik0/furin/client";',
      'import { MobileNav } from "../../components/mobile-nav";',
      'import { route as rootRoute } from "../root";',
      "",
      "export const route = createRoute({",
      "  parent: rootRoute,",
      "  layout: ({ children }) => (",
      "    <section>",
      "      <MobileNav />",
      "      {children}",
      "    </section>",
      "  ),",
      "});",
    ].join("\n")
  );

  writeAppFile(
    app.path,
    "src/pages/docs/index.tsx",
    [
      'import { route } from "./_route";',
      "",
      "export default route.page({",
      "  component: () => <main>Docs page</main>,",
      "});",
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
    for (let i = 0; i < 80; i++) {
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
    expect(html).toContain("Home page");
    expect(html).toContain("__FURIN_DATA__");
    expect(html).toContain('id="root"');
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
        'import { route as rootRoute } from "./root";',
        "",
        "export default rootRoute.page({",
        "  component: () => <main>Updated via HMR</main>,",
        "});",
      ].join("\n")
    );

    // Poll until SSR returns updated content (or timeout after ~10s)
    let html = "";
    for (let i = 0; i < 40; i++) {
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
        'import { route as rootRoute } from "./root";',
        "",
        "export default rootRoute.page({",
        "  component: () => <main>Second edit works</main>,",
        "});",
      ].join("\n")
    );

    // Poll until SSR reflects the second edit (or timeout after ~10s)
    let html = "";
    for (let i = 0; i < 40; i++) {
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

    for (let i = 0; i < 40; i++) {
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
        'import { createRoute } from "@teyik0/furin/client";',
        "",
        "export const route = createRoute({",
        '  layout: ({ children }) => <div data-root-version="root-v2">{children}</div>,',
        "});",
      ].join("\n")
    );

    let updatedResponse: Response | null = null;
    let updatedHtml = "";
    for (let i = 0; i < 40; i++) {
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
});
