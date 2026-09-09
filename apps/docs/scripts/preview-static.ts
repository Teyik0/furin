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
import { join } from "node:path";

interface StaticPreviewOptions {
  basePath: string;
  distDir: string;
  port: number;
}

const TRAILING_SLASHES_RE = /\/+$/;

export function startStaticPreview({ basePath, distDir, port }: StaticPreviewOptions) {
  const normalizedBasePath = basePath.replace(TRAILING_SLASHES_RE, "");
  const faviconPath = join(distDir, "favicon.ico");
  const indexPath = join(distDir, "index.html");
  const notFoundPath = join(distDir, "404.html");

  function notFound(): Response {
    return new Response(Bun.file(notFoundPath), { status: 404 });
  }

  const redirectToBasePath = (request: Request) =>
    Response.redirect(new URL(`${normalizedBasePath}/`, request.url), 302);
  const rootRoutes = normalizedBasePath
    ? {
        [normalizedBasePath]: redirectToBasePath,
        "/": redirectToBasePath,
      }
    : { "/": Bun.file(indexPath) };

  return Bun.serve({
    routes: {
      [`${normalizedBasePath}/_client/*`]: { dir: join(distDir, "_client") },
      "/favicon.ico": existsSync(faviconPath) ? Bun.file(faviconPath) : notFound(),
      ...rootRoutes,
    },
    async fetch(request) {
      const url = new URL(request.url);
      const { pathname } = url;
      if (!pathname.startsWith(`${normalizedBasePath}/`)) {
        return notFound();
      }

      const logicalPath = pathname.slice(normalizedBasePath.length);
      const exactFile = Bun.file(join(distDir, logicalPath));
      if (!logicalPath.endsWith("/") && (await exactFile.exists())) {
        return new Response(exactFile);
      }

      const indexFile = Bun.file(join(distDir, logicalPath, "index.html"));
      if (await indexFile.exists()) {
        if (!pathname.endsWith("/")) {
          url.pathname = `${pathname}/`;
          return Response.redirect(url, 302);
        }
        return new Response(indexFile);
      }

      return notFound();
    },
    port,
  });
}

if (import.meta.main) {
  const distDir = join(import.meta.dir, "../dist");
  const basePath = "/furin";
  const port = 3012;
  startStaticPreview({ basePath, distDir, port });

  console.log("\x1b[32m◆\x1b[0m Preview server ready");
  console.log(`  Local:  http://localhost:${port}${basePath}/`);
  console.log(`  Serves: ${distDir}`);
  console.log("  Press Ctrl+C to stop\n");
}
