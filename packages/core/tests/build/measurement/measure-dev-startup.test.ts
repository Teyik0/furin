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
      '    return new Response("<h1>ready</h1>", { headers: { "Content-Type": "text/html" } });',
      "  },",
      "});",
    ].join("\n")
  );

  try {
    const sample = await measureAppStartup(
      projectDir,
      {
        first: { path: "/", contains: "<h1>ready</h1>" },
        second: { path: "/second", contains: "<h1>ready</h1>" },
        preload: undefined,
      },
      {}
    );
    expect(sample.listenMs).toBeGreaterThanOrEqual(80);
    expect(sample.readyMs - sample.listenMs).toBeGreaterThanOrEqual(60);
    expect(sample.secondRouteMs).toBeGreaterThanOrEqual(60);
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});

test("an HTTP 200 without the expected page content fails the startup measurement", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "furin-startup-content-"));
  mkdirSync(join(projectDir, "src"));
  writeFileSync(
    join(projectDir, "src/server.ts"),
    `Bun.serve({ port: Number(process.env.PORT), fetch: () => new Response("<html></html>", {
      headers: { "Content-Type": "text/html" }
    }) });`
  );
  try {
    await expect(
      measureAppStartup(
        projectDir,
        {
          first: { path: "/", contains: "Page content" },
          second: { path: "/second", contains: "Second page" },
          preload: undefined,
        },
        {}
      )
    ).rejects.toThrow("did not render the expected HTML (HTTP 200)");
  } finally {
    rmSync(projectDir, { force: true, recursive: true });
  }
});
