import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureAppStartup } from "../../../../../scripts/measure-dev-startup.ts";

test("measures a new Bun process through port open and its first complete response", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "furin-startup-probe-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(
    join(projectDir, "src/server.ts"),
    [
      "await Bun.sleep(80);",
      "Bun.serve({",
      "  port: Number(process.env.PORT),",
      '  hostname: "127.0.0.1",',
      "  fetch: async () => {",
      "    await Bun.sleep(60);",
      '    return new Response("ready");',
      "  },",
      "});",
    ].join("\n")
  );

  try {
    const sample = await measureAppStartup(projectDir, "/", {});
    expect(sample.listenMs).toBeGreaterThanOrEqual(80);
    expect(sample.readyMs - sample.listenMs).toBeGreaterThanOrEqual(60);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});
