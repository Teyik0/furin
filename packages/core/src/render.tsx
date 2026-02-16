import type { StaticOptions } from "@elysiajs/static/types";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { ResolvedRoute } from "./router";
import { Shell } from "./shell";

// ISR Cache
const isrCache = new Map<string, { html: string; generatedAt: number; revalidate: number }>();

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

const CLIENT_JS_PATH = "/_client/_hydrate.js";

function buildElement(route: ResolvedRoute, data: Record<string, unknown>): ReactNode {
  const Component = route.page.component;
  let element: ReactNode = <Component {...data} />;

  // Wrap inside-out with layouts from routeChain (outermost first in array)
  for (let i = route.routeChain.length - 1; i >= 0; i--) {
    const routeEntry = route.routeChain[i];
    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  return (
    <Shell clientJsPath={CLIENT_JS_PATH} data={data}>
      {element}
    </Shell>
  );
}

/**
 * Run all loaders in the route chain + page loader, accumulating data flat.
 */
async function runLoaders(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};

  // Run route chain loaders in order (top-down)
  for (const ancestor of route.routeChain) {
    if (ancestor.loader) {
      const result = await ancestor.loader({ ...data, params, query });
      data = { ...data, ...result };
    }
  }

  // Run page-level loader
  if (route.page.loader) {
    const result = await route.page.loader({ ...data, params, query });
    data = { ...data, ...result };
  }

  return data;
}

/**
 * Render a route to a full HTML string.
 * Runs all loaders, waits for all content (allReady),
 * and returns the complete HTML.
 */
export async function renderToHTML(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>
) {
  const data = await runLoaders(route, params, query);
  const element = buildElement(route, { ...data, params, query });
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return streamToString(stream);
}

/**
 * Render a route to a ReadableStream for streaming SSR.
 */
export async function renderToStream(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>
) {
  const data = await runLoaders(route, params, query);
  const element = buildElement(route, { ...data, params, query });
  return renderToReadableStream(element);
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  _config: StaticOptions<string>
) {
  const resolvedPath = Object.entries(params ?? {}).reduce((path: string, [key, val]) => {
    const placeholder = key === "*" ? "*" : `:${key}`;
    return path.replace(placeholder, () => val);
  }, route.pattern);

  const cached = ssgCache.get(resolvedPath);
  if (cached) {
    return cached;
  }

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
  const revalidate = route.page._route.revalidate ?? 60;
  const params = ctx.params ?? {};

  const cacheKey = Object.entries(params).reduce((path: string, [key, val]: [string, string]) => {
    const placeholder = key === "*" ? "*" : `:${key}`;
    return path.replace(placeholder, () => val);
  }, route.pattern);

  const cached = isrCache.get(cacheKey);

  if (cached) {
    const age = Date.now() - cached.generatedAt;
    const isFresh = age < revalidate * 1000;

    if (!isFresh) {
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
