import { expect, test } from "bun:test";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("Cloudflare selects platform dependency exports without losing Furin source contexts", async () => {
  const app = createTmpApp("cli-app-ssr");
  let runtime: Miniflare | undefined;
  try {
    for (const platform of ["browser", "workerd"]) {
      const directory = `node_modules/worker-conditions-${platform}`;
      writeAppFile(app.path, `${directory}/package.json`, JSON.stringify({
        name: `worker-conditions-${platform}`,
        type: "module",
        exports: {
          bun: "./bun.js",
          [platform]: "./safe.js",
          default: "./default.js",
        },
      }));
      writeAppFile(app.path, `${directory}/bun.js`, 'export const marker = () => "bun:" + Bun.version;');
      writeAppFile(app.path, `${directory}/safe.js`, `export const marker = () => "${platform}-safe";`);
      writeAppFile(app.path, `${directory}/default.js`, 'export const marker = () => "default";');
    }
    writeAppFile(app.path, "src/pages/dashboard.tsx", `import { defineRoute } from "@teyik0/furin";
import { marker as browser } from "worker-conditions-browser";
import { marker as workerd } from "worker-conditions-workerd";
import { route as rootRoute } from "./root";
export const route = defineRoute()
  .config({ layout: rootRoute, mode: "ssr" })
  .loader(() => ({ marker: browser() + ":" + workerd() }))
  .page(({ marker }) => <main>{marker}</main>);
`);
    const build = await runCli(["build", "--target", "cloudflare"], { cwd: app.path });
    expect(build.exitCode, build.stderr).toBe(0);
    runtime = new Miniflare({
      modules: [{ type: "ESModule", path: join(app.path, ".furin/build/cloudflare/worker.js") }],
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
    });
    for (const path of ["/dashboard", "/_furin/data?path=%2Fdashboard"]) {
      const response = await runtime.dispatchFetch(`http://localhost${path}`);
      const body = await response.text();
      expect(response.status, body).toBe(200);
      expect(body).toContain("browser-safe:workerd-safe");
      expect(body).not.toContain("bun:");
    }
  } finally {
    await runtime?.dispose();
    app.cleanup();
  }
}, 60_000);
