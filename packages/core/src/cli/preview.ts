import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;

export interface StaticPreviewOptions {
  basePath: string;
  distDir: string;
  port: number;
}

function normalizeBasePath(basePath: string): string {
  if (basePath === "" || basePath === "/") {
    return "";
  }
  if (!basePath.startsWith("/")) {
    throw new Error(`[furin] preview: basePath must start with "/" (received "${basePath}").`);
  }
  return basePath.replace(TRAILING_SLASHES_RE, "");
}

export function startStaticPreview({
  basePath: rawBasePath,
  distDir: rawDistDir,
  port,
}: StaticPreviewOptions): Bun.Server<undefined> {
  const basePath = normalizeBasePath(rawBasePath);
  const distDir = resolve(rawDistDir);
  const indexPath = join(distDir, "index.html");
  const notFoundPath = join(distDir, "404.html");
  const faviconPath = join(distDir, "favicon.ico");

  if (!(existsSync(indexPath) && existsSync(notFoundPath))) {
    throw new Error(
      `[furin] preview: "${distDir}" is not a Furin static export. Run \`furin build --target static\` first.`
    );
  }

  const notFound = (): Response => new Response(Bun.file(notFoundPath), { status: 404 });
  const clientDir = join(distDir, "_client");
  const fetchStaticFile = async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url);
    if (basePath && pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return notFound();
    }

    const logicalPath = pathname.slice(basePath.length).replace(LEADING_SLASHES_RE, "");
    const exactPath = resolve(distDir, logicalPath);
    const relativePath = relative(distDir, exactPath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      return notFound();
    }

    const exactFile = Bun.file(exactPath);
    if (!pathname.endsWith("/") && (await exactFile.exists())) {
      return new Response(exactFile);
    }

    const indexFile = Bun.file(join(exactPath, "index.html"));
    if (await indexFile.exists()) {
      return new Response(indexFile);
    }

    return notFound();
  };

  if (basePath) {
    return Bun.serve({
      routes: {
        "/": (request) => Response.redirect(new URL(`${basePath}/`, request.url), 302),
        [basePath]: Bun.file(indexPath),
        [`${basePath}/_client/*`]: { dir: clientDir },
        "/favicon.ico": existsSync(faviconPath) ? Bun.file(faviconPath) : notFound(),
      },
      fetch: fetchStaticFile,
      port,
    });
  }

  return Bun.serve({
    routes: {
      "/": Bun.file(indexPath),
      "/_client/*": { dir: clientDir },
      "/favicon.ico": existsSync(faviconPath) ? Bun.file(faviconPath) : notFound(),
    },
    fetch: fetchStaticFile,
    port,
  });
}
