// biome-ignore-all lint/performance/noAwaitInLoops: observe HMR updates through HTTP polling
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../../support/app-fixtures.ts";
import { getFreePort } from "../../support/hmr.ts";
import { waitForHttp } from "../../support/http.ts";
import { startProcess } from "../../support/process.ts";

test.each(["@/components/public-footer", "../components/public-footer"])(
  "editing a footer imported from %s refreshes the ISR root HTML without restarting Bun",
  async (specifier) => {
    const app = createTmpApp("hmr-aliased-footer");
    const port = await getFreePort();
    const rootPath = "src/pages/root.tsx";
    const rootSource = readFileSync(join(app.path, rootPath), "utf8");
    writeAppFile(app.path, rootPath, rootSource.replace("@/components/public-footer", specifier));
    const server = startProcess(["bun", "--hot", join(app.path, "src/server.ts")], {
      cwd: app.path,
      env: { PORT: String(port) },
    });
    try {
      const url = `http://localhost:${port}/`;
      const initial = await waitForHttp(url, {});
      expect(await initial.text()).toContain('class="rounded-full ring-1"');
      expect(await (await fetch(url)).text()).toContain('class="rounded-full ring-1"');

      const footerPath = "src/components/public-footer.tsx";
      const source = readFileSync(join(app.path, footerPath), "utf8");
      writeAppFile(app.path, footerPath, source.replace("rounded-full ring-1", "rounded-full"));

      let html = "";
      for (let attempt = 0; attempt < 150; attempt += 1) {
        html = await (await fetch(url)).text();
        if (html.includes('class="rounded-full"')) {
          break;
        }
        await Bun.sleep(100);
      }
      expect(html, server.getStderr()).toContain('class="rounded-full"');
      expect(html).not.toContain('class="rounded-full ring-1"');
      expect(server.getStdout().match(/footer-fixture-started/g)).toHaveLength(1);
    } finally {
      server.kill();
      await server.exitCode;
      app.cleanup();
    }
  },
  30_000
);
