import { expect, test } from "bun:test";
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
    const handlerPath = join(app.path, ".vercel/output/functions/__server.func/handler.js");
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
    });
    expect(response.exitCode).toBe(0);
    expect(response.stdout.toString()).toContain('200 {"changes":[],"cursor":"7"');
  } finally {
    app.cleanup();
  }
}, 30_000);
