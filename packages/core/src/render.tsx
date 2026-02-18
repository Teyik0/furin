import type { StaticOptions } from "@elysiajs/static/types";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import { getModuleVersion } from "./hmr/watcher.js";
import type { ResolvedRoute } from "./router";
import { Shell } from "./shell";

// ISR Cache
const isrCache = new Map<string, { html: string; generatedAt: number; revalidate: number }>();

// SSG Cache (pre-rendered at startup)
const ssgCache = new Map<string, string>();

// Page module cache for dev mode
declare global {
  var __elysionPageCache: Map<string, { page: unknown; timestamp: number }>;
}

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

/**
 * Load page module dynamically for HMR support
 * In dev mode, this reloads the module to get fresh code
 */
async function loadPageModule(route: ResolvedRoute, dev: boolean) {
  if (!dev && route.page) {
    return route.page;
  }

  // In dev mode, always reload the page module with cache-busting
  if (dev) {
    try {
      const version = getModuleVersion(route.pagePath);
      const mod = await import(`${route.pagePath}?v=${version}`);
      const page = mod.default;
      route.page = page;
      return page;
    } catch (error) {
      console.error(`[elysion] Failed to load page ${route.pagePath}:`, error);
      if (route.page) {
        return route.page;
      }
      throw error;
    }
  }

  return route.page;
}

function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  dev: boolean
): ReactNode {
  const page = route.page;
  if (!page) {
    return <div>Loading...</div>;
  }

  const Component = page.component;
  let element: ReactNode = <Component {...data} />;

  for (let i = route.routeChain.length - 1; i >= 0; i--) {
    const routeEntry = route.routeChain[i];
    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  return (
    <Shell clientJsPath={CLIENT_JS_PATH} data={data} dev={dev}>
      {element}
    </Shell>
  );
}

async function runLoaders(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};

  for (const ancestor of route.routeChain) {
    if (ancestor.loader) {
      const result = await ancestor.loader({ ...data, params, query });
      data = { ...data, ...result };
    }
  }

  if (route.page?.loader) {
    const result = await route.page.loader({ ...data, params, query });
    data = { ...data, ...result };
  }

  return data;
}

export async function renderToHTML(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>,
  dev = false
) {
  // Reload page module in dev mode for HMR
  await loadPageModule(route, dev);

  const data = await runLoaders(route, params, query);
  const element = buildElement(route, { ...data, params, query }, dev);
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  return streamToString(stream);
}

export async function renderToStream(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>,
  dev = false
) {
  // Reload page module in dev mode for HMR
  await loadPageModule(route, dev);

  const data = await runLoaders(route, params, query);
  const element = buildElement(route, { ...data, params, query }, dev);
  return renderToReadableStream(element);
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  _config: StaticOptions<string>,
  dev = false
) {
  const resolvedPath = Object.entries(params ?? {}).reduce((path: string, [key, val]) => {
    const placeholder = key === "*" ? "*" : `:${key}`;
    return path.replace(placeholder, () => val);
  }, route.pattern);

  const cached = ssgCache.get(resolvedPath);
  if (cached && !dev) {
    return cached;
  }

  const html = await renderToHTML(route, params, {}, dev);

  if (!dev) {
    ssgCache.set(resolvedPath, html);
  }

  return html;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: { params?: Record<string, string>; query?: Record<string, string> },
  _config: StaticOptions<string>,
  dev = false
): Promise<Response> {
  const stream = await renderToStream(route, ctx.params ?? {}, ctx.query ?? {}, dev);

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
  _config: StaticOptions<string>,
  dev = false
): Promise<Response> {
  const revalidate = route.page?._route.revalidate ?? 60;
  const params = ctx.params ?? {};

  const cacheKey = Object.entries(params).reduce((path: string, [key, val]: [string, string]) => {
    const placeholder = key === "*" ? "*" : `:${key}`;
    return path.replace(placeholder, () => val);
  }, route.pattern);

  const cached = isrCache.get(cacheKey);

  if (cached && !dev) {
    const age = Date.now() - cached.generatedAt;
    const isFresh = age < revalidate * 1000;

    if (!isFresh) {
      revalidateInBackground(route, params, cacheKey, revalidate, dev);
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

  const html = await renderToHTML(route, params, {}, dev);

  if (!dev) {
    isrCache.set(cacheKey, { html, generatedAt: Date.now(), revalidate });
  }

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
  revalidate: number,
  dev: boolean
) {
  renderToHTML(route, params, {}, dev)
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

export async function loadPageAndRender(
  route: ResolvedRoute,
  ctx: { params?: Record<string, string>; query?: Record<string, string> },
  config: StaticOptions<string>,
  dev: boolean
): Promise<Response> {
  return await renderSSR(route, ctx, config, dev);
}

// HMR: Accept hot module replacement
if (import.meta.hot) {
  import.meta.hot.accept();
}
