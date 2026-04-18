/**
 * Local preview server for the static export.
 *
 * Mirrors GitHub Pages behaviour:
 *   - serves dist/ mounted at /furin/
 *   - unknown paths fall back to dist/404.html (the SPA shell)
 *   - navigating to / redirects to /furin/
 *
 * Usage: bun run preview:static
 */
import { existsSync } from "node:fs";
import { extname, join } from "node:path";

const distDir = join(import.meta.dir, "../dist");
const basePath = "/furin";
const port = 3012;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".txt": "text/plain",
};

function mime(filePath: string): string {
  return MIME[extname(filePath)] ?? "application/octet-stream";
}

function serveFile(filePath: string, status: number): Response {
  const file = Bun.file(filePath);
  return new Response(file, {
    status,
    headers: { "content-type": mime(filePath) },
  });
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const { pathname } = url;

    // Redirect bare root → basePath
    if (pathname === "/" || pathname === "") {
      return Response.redirect(`${url.origin}${basePath}/`, 302);
    }

    // Serve favicon.ico from dist root even when requested without basePath
    // (browsers always fetch /favicon.ico at the domain root)
    if (pathname === "/favicon.ico") {
      const faviconPath = join(distDir, "favicon.ico");
      if (existsSync(faviconPath)) {
        return serveFile(faviconPath, 200);
      }
    }

    // Strip basePath prefix
    let logical: string;
    if (pathname.startsWith(`${basePath}/`)) {
      logical = pathname.slice(basePath.length); // e.g. "/docs/routing"
    } else if (pathname === basePath) {
      logical = "/";
    } else {
      // Path outside basePath — serve 404 shell (mirrors GitHub Pages)
      return serveFile(join(distDir, "404.html"), 404);
    }

    // Try exact file first (e.g. /_client/_hydrate.js)
    const exactPath = join(distDir, logical);
    if (existsSync(exactPath) && !exactPath.endsWith("/")) {
      const stat = Bun.file(exactPath);
      if (await stat.exists()) {
        return serveFile(exactPath, 200);
      }
    }

    // Try directory index (e.g. /docs/routing → dist/docs/routing/index.html)
    const indexPath = join(distDir, logical, "index.html");
    if (existsSync(indexPath)) {
      return serveFile(indexPath, 200);
    }

    // SPA fallback — serve 404.html shell so client-side router can take over
    return serveFile(join(distDir, "404.html"), 404);
  },
});

console.log("\x1b[32m◆\x1b[0m Preview server ready");
console.log(`  Local:  http://localhost:${port}${basePath}/`);
console.log(`  Serves: ${distDir}`);
console.log("  Press Ctrl+C to stop\n");
