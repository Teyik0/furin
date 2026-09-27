import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  mixedRuntimePlugin,
  type RuntimeTargetApp,
} from "../../../src/adapter/runtime-build.ts";

async function buildCacheImport(apps: RuntimeTargetApp[]): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "furin-no-mixed-build-"));
  try {
    const entry = join(dir, "entry.js");
    const mixedCache = resolve(import.meta.dir, "../../../src/server/render/mixed-cache.ts");
    writeFileSync(
      entry,
      `import { cacheMixedPublicLoader } from ${JSON.stringify(mixedCache)};\nconsole.log(cacheMixedPublicLoader());`
    );
    const build = await Bun.build({
      entrypoints: [entry],
      format: "esm",
      minify: true,
      plugins: [mixedRuntimePlugin(apps)],
      target: "bun",
    });
    expect(build.success).toBe(true);
    return (await Promise.all(build.outputs.map((output) => output.text()))).join("\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("omits mixed loader cache code when the build has no mixed routes", async () => {
  expect(await buildCacheImport([])).not.toContain("render:mixed-public-loader");
});

test("keeps mixed loader cache code when a route needs it", async () => {
  const app = {
    routes: [
      {
        mode: "isr",
        page: { _route: {}, mode: "isr" },
        routeChain: [{ loader: () => ({ user: "alice" }), mode: "ssr" }],
      },
    ],
  } as unknown as RuntimeTargetApp;
  expect(await buildCacheImport([app])).toContain("render:mixed-public-loader");
});
