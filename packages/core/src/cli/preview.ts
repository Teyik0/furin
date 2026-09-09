import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

const LEADING_SLASHES_RE = /^\/+/;
const TRAILING_SLASHES_RE = /\/+$/;

export interface StaticPreviewOptions {
  basePath: string;
  distDir: string;
  port: number;
}

export function normalizeStaticPreviewBasePath(basePath: string): string {
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
  const basePath = normalizeStaticPreviewBasePath(rawBasePath);
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
    const encodedPathname = new URL(request.url).pathname;
    let pathname: string;
    try {
      pathname = decodeURIComponent(encodedPathname);
    } catch {
      return notFound();
    }
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

  const entryRoutes = basePath
    ? {
        "/": (request: Request) => Response.redirect(new URL(`${basePath}/`, request.url), 302),
        [basePath]: Bun.file(indexPath),
      }
    : { "/": Bun.file(indexPath) };

  return Bun.serve({
    fetch: fetchStaticFile,
    port,
    routes: {
      ...entryRoutes,
      [`${basePath}/_client/*`]: { dir: clientDir },
      "/favicon.ico": existsSync(faviconPath) ? Bun.file(faviconPath) : notFound(),
    },
  });
}
