import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStaticPreview } from "../scripts/preview-static";

const tempDirs: string[] = [];
const servers: Bun.Server<undefined>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("static preview", () => {
  test("serves the exported directory under its base path with a 404 fallback", async () => {
    const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-"));
    tempDirs.push(distDir);
    mkdirSync(join(distDir, "docs"), { recursive: true });
    mkdirSync(join(distDir, "_client"), { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<h1>Home</h1>");
    writeFileSync(join(distDir, "docs/index.html"), "<h1>Docs</h1>");
    writeFileSync(join(distDir, "_client/asset.txt"), "static asset");
    writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

    const server = startStaticPreview({
      basePath: "/furin/",
      distDir,
      port: 0,
    });
    servers.push(server);

    const root = await fetch(new URL("/", server.url), { redirect: "manual" });
    expect(root.status).toBe(302);
    expect(root.headers.get("location")).toBe(new URL("/furin/", server.url).href);

    const basePathRoot = await fetch(new URL("/furin", server.url), {
      redirect: "manual",
    });
    expect(basePathRoot.status).toBe(302);
    expect(basePathRoot.headers.get("location")).toBe(new URL("/furin/", server.url).href);

    const homepage = await fetch(new URL("/furin/", server.url));
    expect(await homepage.text()).toBe("<h1>Home</h1>");

    const nestedRedirect = await fetch(new URL("/furin/docs", server.url), {
      redirect: "manual",
    });
    expect(nestedRedirect.status).toBe(302);
    expect(nestedRedirect.headers.get("location")).toBe(new URL("/furin/docs/", server.url).href);

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

  test.each(["", "/"])(
    "serves an export mounted at the root for base path %p",
    async (basePath) => {
      const distDir = mkdtempSync(join(tmpdir(), "furin-static-preview-"));
      tempDirs.push(distDir);
      mkdirSync(join(distDir, "_client"));
      writeFileSync(join(distDir, "index.html"), "<h1>Home</h1>");
      writeFileSync(join(distDir, "404.html"), "<h1>Missing</h1>");

      const server = startStaticPreview({
        basePath,
        distDir,
        port: 0,
      });
      servers.push(server);

      const homepage = await fetch(server.url);
      expect(homepage.status).toBe(200);
      expect(await homepage.text()).toBe("<h1>Home</h1>");
    }
  );
});
