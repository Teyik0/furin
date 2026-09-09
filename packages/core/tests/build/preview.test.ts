import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticPreview } from "../../src/cli/preview.ts";
import { getTestPort } from "../support/http.ts";
import { startCli } from "../support/process.ts";

const tempDirs: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("static preview", () => {
  test("serves a static export from a base path with Bun directory routes", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-"));
    tempDirs.push(distDir);
    mkdirSync(join(distDir, "docs"), { recursive: true });
    mkdirSync(join(distDir, "_client"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<h1>Home</h1>");
    writeFileSync(join(distDir, "docs/index.html"), "<h1>Docs</h1>");
    writeFileSync(join(distDir, "_client/asset.txt"), "static asset");
    writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

    const server = startStaticPreview({
      basePath: "/furin",
      distDir,
      port: 0,
    });
    servers.push(server);

    const root = await fetch(new URL("/", server.url), { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(new URL("/furin/", server.url).href);

    const homepage = await fetch(new URL("/furin/", server.url));
    expect(await homepage.text()).toBe("<h1>Home</h1>");

    const nestedPage = await fetch(new URL("/furin/docs/", server.url));
    expect(await nestedPage.text()).toBe("<h1>Docs</h1>");

    const range = await fetch(new URL("/furin/_client/asset.txt", server.url), {
      headers: { range: "bytes=0-5" },
    });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe("static");

    const missing = await fetch(new URL("/furin/missing", server.url));
    expect(missing.status).toBe(404);
    expect(await missing.text()).toBe("<h1>Missing</h1>");
  });

  test("serves percent-encoded Unicode paths from their decoded filesystem path", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-unicode-"));
    tempDirs.push(distDir);
    mkdirSync(join(distDir, "_client"), { recursive: true });
    mkdirSync(join(distDir, "café"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<h1>Home</h1>");
    writeFileSync(join(distDir, "café/index.html"), "<h1>Café</h1>");
    writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

    const server = startStaticPreview({
      basePath: "",
      distDir,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(new URL("/caf%C3%A9/", server.url));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>Café</h1>");
  });

  test("rejects malformed percent-encoded paths before filesystem lookup", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-malformed-"));
    tempDirs.push(distDir);
    mkdirSync(join(distDir, "_client"), { recursive: true });
    mkdirSync(join(distDir, "%E0%A4%A"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<h1>Home</h1>");
    writeFileSync(join(distDir, "%E0%A4%A/index.html"), "<h1>Unsafe</h1>");
    writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

    const server = startStaticPreview({
      basePath: "",
      distDir,
      port: 0,
    });
    servers.push(server);

    const response = await fetch(new URL("/%E0%A4%A/", server.url));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("<h1>Missing</h1>");
  });

  test("serves root deployments without redirecting the homepage", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-root-"));
    tempDirs.push(distDir);
    mkdirSync(join(distDir, "_client"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<h1>Root</h1>");
    writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

    const server = startStaticPreview({
      basePath: "",
      distDir,
      port: 0,
    });
    servers.push(server);

    const homepage = await fetch(server.url, { redirect: "manual" });
    expect(homepage.status).toBe(200);
    expect(await homepage.text()).toBe("<h1>Root</h1>");
  });

  test("previews basePath root and prints its valid local URL", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-cli-root-"));
    tempDirs.push(distDir);
    mkdirSync(join(distDir, "_client"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<h1>Root</h1>");
    writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

    const port = getTestPort();
    const cli = startCli(
      ["preview", "--dir", ".", "--basePath", "/", "--port", String(port)],
      { cwd: distDir },
    );
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (cli.getStdout().includes("Local:")) {
          break;
        }
        await Bun.sleep(10);
      }
      expect(cli.getStdout()).toContain(`Local:  http://localhost:${port}/`);
      expect(cli.getStderr()).toBe("");
    } finally {
      cli.kill();
      await cli.exitCode;
    }
  });
});
