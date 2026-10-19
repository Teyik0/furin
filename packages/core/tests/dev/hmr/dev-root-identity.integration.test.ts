// biome-ignore-all lint/performance/noAwaitInLoops: integration test polling must wait between retries
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

/**
 * In dev, root.tsx has ONE module identity per source version: discovery,
 * the per-request renderer and the pages' rewritten relative imports all load
 * the same versioned module, so its top level runs once per edit.
 */
const ROOT_EVALS_ATTRIBUTE_RE = /data-root-evals="(\d+)"/;

function rootSource(version: string): string {
  return [
    'import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";',
    "",
    "const counter = globalThis as { __rootEvals?: number };",
    "counter.__rootEvals = (counter.__rootEvals ?? 0) + 1;",
    "",
    "export const route = defineRootRoute()",
    '  .config({ mode: "ssr" })',
    "  .layout(({ children }) => (",
    '    <html lang="en">',
    "      <head><HeadContent /></head>",
    `      <body data-root-version="${version}" data-root-evals={String(counter.__rootEvals)}>`,
    "        {children}",
    "        <Scripts />",
    "      </body>",
    "    </html>",
    "  ));",
  ].join("\n");
}

function rootEvaluations(html: string): number {
  // biome-ignore lint/suspicious/noUnnecessaryConditions: a missing attribute must yield NaN so the assertion fails.
  return Number(ROOT_EVALS_ATTRIBUTE_RE.exec(html)?.[1]);
}

describe.serial("dev root module identity", () => {
  const app = createTmpApp("cli-app");
  let port: number;
  let server: ReturnType<typeof startProcess>;

  writeAppFile(app.path, "src/pages/root.tsx", rootSource("root-v1"));
  writeAppFile(
    app.path,
    "src/pages/index.tsx",
    [
      'import { defineRoute } from "@teyik0/furin";',
      'import { route as rootRoute } from "./root";',
      "",
      "export const route = defineRoute()",
      '  .config({ layout: rootRoute, mode: "ssr" })',
      "  .page(() => <main>Home</main>);",
    ].join("\n")
  );

  beforeAll(async () => {
    port = await getFreePort();
    server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    await waitForHttp(`http://localhost:${port}/`, { timeoutMs: 20_000 }).catch((error) => {
      throw new Error(`${error}\nstderr:\n${server.getStderr()}`);
    });
  }, 30_000);

  afterAll(async () => {
    server?.kill();
    await server?.exitCode;
    app.cleanup();
  });

  test("root.tsx top level runs once after start and a request", async () => {
    const html = await (await fetch(`http://localhost:${port}/`)).text();

    expect(html).toContain("Home");
    expect(rootEvaluations(html)).toBe(1);
  });

  test("a root edit refreshes 404 pages and evaluates the new version once", async () => {
    const before = await fetch(`http://localhost:${port}/missing`);
    expect(before.status).toBe(404);
    expect(await before.text()).toContain("root-v1");

    writeAppFile(app.path, "src/pages/root.tsx", rootSource("root-v2"));

    let notFoundHtml = "";
    for (let i = 0; i < 40; i += 1) {
      notFoundHtml = await (await fetch(`http://localhost:${port}/missing`)).text();
      if (notFoundHtml.includes("root-v2")) {
        break;
      }
      await Bun.sleep(250);
    }
    expect(notFoundHtml).toContain("root-v2");

    const pageHtml = await (await fetch(`http://localhost:${port}/`)).text();
    expect(pageHtml).toContain("root-v2");
    expect(rootEvaluations(pageHtml)).toBe(2);
    expect(rootEvaluations(notFoundHtml)).toBe(2);
  }, 20_000);
});
