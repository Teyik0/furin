import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildApp } from "../../../src/build/index.ts";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";

test("Vercel prerenders production-compatible composite Flight for direct hydration", async () => {
  const app = createTmpApp("cli-app");
  const previousNodeEnv = process.env.NODE_ENV;
  try {
    writeAppFile(
      app.path,
      "src/pages/rsc.tsx",
      [
        'import { defineRoute } from "@teyik0/furin";',
        'import { CompositeComponent, createCompositeComponent } from "@teyik0/furin/rsc";',
        'import { route as rootRoute } from "./root";',
        "export const route = defineRoute()",
        '  .config({ layout: rootRoute, mode: "isr", revalidate: 300 })',
        "  .loader(async () => ({ shell: await createCompositeComponent<{ action: () => React.ReactNode }>(({ action }) => <main><h1>RSC page</h1>{action()}</main>) }))",
        '  .page(({ shell }) => <CompositeComponent src={shell} action={() => <button type="button">Action</button>} />);',
      ].join("\n")
    );
    await buildApp({ rootDir: app.path, target: "vercel" });
    expect(process.env.NODE_ENV).toBe(previousNodeEnv);
    const fallbackPath = join(app.path, ".vercel/output/functions/rsc-isr.prerender-fallback.html");
    const html = readFileSync(fallbackPath, "utf8");
    expect(html).toContain('id="__FURIN_ROUTE_FRAMES__"');
    expect(html).toContain('data-furin-document-state=""');
    expect(html).toContain("RSC page");

    const parseModule = pathToFileURL(
      join(import.meta.dir, "../../../src/shared/deferred-ndjson.ts")
    ).href;
    const sourceModule = pathToFileURL(join(import.meta.dir, "../../../src/rsc/shared.tsx")).href;
    const script = `
      const html = await Bun.file(process.argv[1]).text();
      const templateId = html.indexOf('id="__FURIN_ROUTE_FRAMES__"');
      const payloadStart = html.indexOf('>', templateId) + 1;
      const payload = html.slice(payloadStart, html.indexOf('</template>', payloadStart))
        .replaceAll('&lt;', '<').replaceAll('&amp;', '&');
      const { parseDeferredNdjson } = await import(${JSON.stringify(parseModule)});
      const { CompositeComponent, getRscSourceState } = await import(${JSON.stringify(sourceModule)});
      const { createElement } = await import('react');
      const { renderToReadableStream } = await import('react-dom/server');
      const parsed = await parseDeferredNdjson(new Blob([payload]).stream(), undefined);
      const state = getRscSourceState(parsed.syncData.shell);
      if (state?.kind !== 'composite') throw new Error('composite source was not restored');
      const element = createElement(CompositeComponent, {
        src: parsed.syncData.shell,
        action: () => createElement('button', { type: 'button' }, 'Action'),
      });
      const rendered = await new Response(await renderToReadableStream(element)).text();
      if (!rendered.includes('<button type="button">Action</button>')) {
        throw new Error('composite slot did not render');
      }
    `;
    const child = Bun.spawn([process.execPath, "-e", script, fallbackPath], {
      cwd: join(import.meta.dir, "../../.."),
      env: { ...process.env, NODE_ENV: "production" },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
  } finally {
    app.cleanup();
  }
}, 60_000);
