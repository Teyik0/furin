import type { IncomingMessage, ServerResponse } from "node:http";
import { Elysia } from "elysia";
import { createMocks } from "node-mocks-http";
import type { InlineConfig, ViteDevServer } from "vite";

export interface VitePluginOptions {
  root?: string;
  vite?: InlineConfig;
}

export interface VitePluginDecorate {
  vite: ViteDevServer | undefined;
}

export async function createVitePlugin(options?: VitePluginOptions) {
  const vite = await import("vite").then((vite) => {
    return vite.createServer({
      root: options?.root,
      ...options?.vite,
      server: {
        ...options?.vite?.server,
        middlewareMode: true,
      },
      appType: "custom",
    });
  });

  return new Elysia().decorate("vite", vite).onRequest(({ request }) => {
    const url = new URL(request.url);
    const pathname = url.pathname;
    if (shouldHandleByVite(pathname)) {
      return handleViteMiddleware(vite, request);
    }
  });
}

function shouldHandleByVite(pathname: string): boolean {
  if (pathname.startsWith("/@vite/")) {
    return true;
  }
  if (pathname.startsWith("/src/")) {
    return true;
  }
  if (pathname.startsWith("/node_modules/")) {
    return true;
  }
  if (pathname === "/") {
    return true;
  }
  if (pathname.endsWith(".html")) {
    return true;
  }
  if (pathname.endsWith(".tsx") || pathname.endsWith(".ts")) {
    return true;
  }
  if (pathname.endsWith(".jsx") || pathname.endsWith(".js")) {
    return true;
  }
  if (pathname.endsWith(".css")) {
    return true;
  }

  return false;
}

async function handleViteMiddleware(vite: ViteDevServer, request: Request): Promise<Response> {
  const url = new URL(request.url);

  const body =
    request.method !== "GET" && request.method !== "HEAD" ? await request.text() : undefined;

  const { req, res } = createMocks({
    method: request.method as "GET" | "POST" | "PUT" | "DELETE" | "PATCH" | "HEAD" | "OPTIONS",
    url: url.pathname + url.search,
    headers: Object.fromEntries(request.headers.entries()),
    body: body as Buffer | undefined,
  });

  return new Promise<Response>((resolve) => {
    const chunks: Buffer[] = [];

    res.write = (chunk: Buffer | string) => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk));
      } else if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      }
      return true;
    };

    res.end = (chunk?: Buffer | string) => {
      if (chunk) {
        if (typeof chunk === "string") {
          chunks.push(Buffer.from(chunk));
        } else if (Buffer.isBuffer(chunk)) {
          chunks.push(chunk);
        }
      }

      const body = Buffer.concat(chunks);
      const headers = new Headers();

      const resHeaders = res.getHeaders();
      for (const [key, value] of Object.entries(resHeaders)) {
        if (value !== undefined) {
          headers.set(key, String(value));
        }
      }

      resolve(
        new Response(body, {
          status: res.statusCode || 200,
          statusText: res.statusMessage,
          headers,
        })
      );

      return res;
    };

    vite.middlewares(req as IncomingMessage, res as ServerResponse, () => {
      resolve(new Response(null, { status: 404 }));
    });
  });
}
