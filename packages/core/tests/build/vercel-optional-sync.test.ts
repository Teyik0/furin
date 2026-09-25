import { expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createTmpApp, writeAppFile } from "../support/app-fixtures.ts";
import { runCli } from "../support/process.ts";

test("the split Vercel function loads optional sync routes when enabled", async () => {
  const app = createTmpApp("cli-app-ssr");
  try {
    writeAppFile(
      app.path,
      "src/server.ts",
      `import { furin } from "@teyik0/furin";
import Elysia from "elysia";

const adapter = {
  scope: "host-local" as const,
  abortMutation: async () => {},
  beginMutation: async () => ({ kind: "conflict" as const, reason: "in-progress" as const }),
  completeMutation: async () => ({ kind: "lost" as const }),
  currentCursor: async () => "7",
  readChanges: async () => ({ changes: [], cursor: "7", hasMore: false, reset: false }),
  renewMutation: async () => "lost" as const,
};

export default new Elysia().use(await furin({
  pagesDir: import.meta.dir + "/pages",
  sync: { adapter, principal: () => "test" },
}));`
    );

    const build = await runCli(["build", "--target", "vercel"], { cwd: app.path });
    expect(build.exitCode).toBe(0);
    const functionDir = join(app.path, ".vercel/output/functions/__server.func");
    const bundleBytes = readdirSync(functionDir)
      .filter((file) => file === "handler.js" || /^chunk-.*\.js$/.test(file))
      .reduce((total, file) => total + statSync(join(functionDir, file)).size, 0);
    expect(await Bun.file(join(functionDir, "index.js")).text()).toContain(
      `server_bundle_bytes: ${bundleBytes}`
    );
    const handlerPath = join(functionDir, "handler.js");
    const response = Bun.spawnSync({
      cmd: [
        process.execPath,
        "-e",
        'const app = (await import(process.argv[1])).default; const response = await app.fetch(new Request("http://localhost/_furin/sync/changes")); console.log(response.status, await response.text());',
        handlerPath,
      ],
      cwd: app.path,
      stderr: "pipe",
      stdout: "pipe",
      timeout: 10_000,
    });
    expect(response.exitCode, response.stderr.toString()).toBe(0);
    expect(response.stdout.toString()).toContain('200 {"changes":[],"cursor":"7"');
  } finally {
    app.cleanup();
  }
}, 30_000);
