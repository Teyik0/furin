import type { StaticOptions } from "@elysiajs/static/types";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { getClientAssets } from "./build";
import type { PageModule } from "./page";
import type { ResolvedRoute } from "./router";
import { Shell } from "./shell";

// ISR Cache
const isrCache = new Map<
  string,
  { html: string; generatedAt: number; revalidate: number }
>();

// SSG Cache (pre-rendered at startup)
const ssgCache = new Map<string, string>();

async function streamToString(stream: ReadableStream): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let html = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    html += decoder.decode(value, { stream: true });
  }

  html += decoder.decode();
  return html;
}

interface RenderableRoute {
  module: PageModule;
  path: string;
}

function buildElement(
  route: RenderableRoute,
  data?: Record<string, unknown>,
  clientAssets?: { js?: string; css?: string }
): ReactNode {
  const Component = route.module.component;
  return (
    <Shell
      clientCssPath={clientAssets?.css}
      clientJsPath={clientAssets?.js}
      data={data}
    >
      <Component {...(data ?? {})} />
    </Shell>
  );
}

/**
 * Render a route to a full HTML string.
 * Calls the loader if present, waits for all content (allReady),
 * and returns the complete HTML.
 *
 * Used by SSG and ISR (which need full strings for caching).
 */
export async function renderToHTML(
  route: RenderableRoute,
  params: Record<string, string>,
  query: Record<string, string>
) {
  let data: Record<string, unknown> | undefined;

  if (route.module.options?.loader?.handler) {
    data =
      (await Promise.resolve(
        route.module.options.loader.handler({ params, query })
      )) ?? undefined;
  }

  // Get client assets from manifest using the URL pattern
  const clientAssets = await getClientAssets(route.pattern);

  const element = buildElement(route, data, clientAssets);
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return streamToString(stream);
}

/**
 * Render a route to a ReadableStream for streaming SSR.
 * The returned stream starts emitting as soon as the shell is ready.
 * Suspense boundaries resolve progressively.
 */
export async function renderToStream(
  route: RenderableRoute,
  params: Record<string, string>,
  query: Record<string, string>
) {
  let data: Record<string, unknown> | undefined;

  if (route.module.options?.loader?.handler) {
    data =
      (await Promise.resolve(
        route.module.options.loader.handler({ params, query })
      )) ?? undefined;
  }

  // Get client assets from manifest using the URL pattern
  const clientAssets = await getClientAssets(route.pattern);

  const element = buildElement(route, data, clientAssets);
  return renderToReadableStream(element);
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  _config: StaticOptions<string>
) {
  const resolvedPath = Object.entries(params ?? {}).reduce(
    (path: string, [key, val]) => {
      const placeholder = key === "*" ? "*" : `:${key}`;
      return path.replace(placeholder, () => val);
    },
    route.pattern
  );
  console.log(resolvedPath);

  const html = await renderToHTML(route, params, {});
  ssgCache.set(resolvedPath, html);

  return html;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: { params?: Record<string, string>; query?: Record<string, string> },
  _config: StaticOptions<string>
): Promise<Response> {
  const stream = await renderToStream(route, ctx.params ?? {}, ctx.query ?? {});

  return new Response(stream, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    },
  });
}

export async function handleISR(
  route: ResolvedRoute,
  ctx: { params?: Record<string, string>; query?: Record<string, string> },
  _config: StaticOptions<string>
): Promise<Response> {
  const revalidate = route.module.options?.revalidate ?? 60;
  const params = ctx.params ?? {};

  // Build a cache key from the pattern with params resolved
  const cacheKey = Object.entries(params).reduce(
    (path: string, [key, val]: [string, string]) => {
      const placeholder = key === "*" ? "*" : `:${key}`;
      return path.replace(placeholder, () => val);
    },
    route.pattern
  );

  const cached = isrCache.get(cacheKey);

  if (cached) {
    const age = Date.now() - cached.generatedAt;
    const isFresh = age < revalidate * 1000;

    if (!isFresh) {
      // Stale — serve stale, revalidate in background
      revalidateInBackground(route, params, cacheKey, revalidate);
    }

    return new Response(cached.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": isFresh
          ? `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate}`
          : "public, s-maxage=0, must-revalidate",
      },
    });
  }

  // Not cached — render fresh
  const html = await renderToHTML(route, params, {});
  isrCache.set(cacheKey, { html, generatedAt: Date.now(), revalidate });

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate}`,
    },
  });
}

function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number
) {
  renderToHTML(route, params, {})
    .then((freshHtml: string) => {
      isrCache.set(cacheKey, {
        html: freshHtml,
        generatedAt: Date.now(),
        revalidate,
      });
    })
    .catch((err: unknown) => {
      console.error("[elysion] ISR background revalidation failed:", err);
    });
}
