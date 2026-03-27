import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startProcess } from "./helpers/run-cli.ts";
import { createTmpApp, writeAppFile } from "./helpers/tmp-app.ts";

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
  const port = 4321 + Math.floor(Math.random() * 1000);
  let server: ReturnType<typeof startProcess>;

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
    for (let i = 0; i < 40; i++) {
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

    // Wait a bit for the file system notification to propagate
    await Bun.sleep(500);

    // Request should return FRESH SSR content
    const html = await (await fetch(`http://localhost:${port}/`)).text();
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

    await Bun.sleep(500);

    const html = await (await fetch(`http://localhost:${port}/`)).text();
    expect(html).toContain("Second edit works");
    expect(html).not.toContain("Updated via HMR");

    // Still no additional restart
    const logs = server.getStdout() + server.getStderr();
    const listenCount = (logs.match(/listening on/g) ?? []).length;
    expect(listenCount).toBe(1);
  }, 15_000);
});
