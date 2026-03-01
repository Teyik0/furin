import { renderToReadableStream } from "react-dom/server";
import type { RootLayout } from "../router";
import { buildHeadInjection } from "../shell";
import { assembleHTML, createSSGContext, resolvePath, streamToString } from "./assemble";
import { isrCache, ssgCache } from "./cache";
import { buildElement, loadPageModule, loadRootModule } from "./element";
import { runLoaders } from "./loaders";
import { getDevTemplate, getProdTemplate } from "./template";

// ── Re-exports (public API) ──────────────────────────────────────────────────
// biome-ignore lint/performance/noBarrelFile: acnowledged
export { type LoaderContext, streamToString } from "./assemble";
export { buildElement, loadPageModule, loadRootModule } from "./element";
export { type LoaderResult, runLoaders } from "./loaders";
export { _setProdTemplate } from "./template";

// ── Types ────────────────────────────────────────────────────────────────────

import type { ResolvedRoute } from "../router";
import type { LoaderContext } from "./assemble";

interface RenderResult {
  headers: Record<string, string>;
  html: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function catchRedirect(err: unknown): Response {
  if (err instanceof Response) {
    return err;
  }
  throw err;
}

async function renderForPath(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout | null,
  dev: boolean,
  origin: string
): Promise<RenderResult> {
  const resolvedPath = resolvePath(route.pattern, params);
  const ctx = createSSGContext(params, resolvedPath, origin);
  return await renderToHTML(route, ctx, root, dev);
}

// ── Core pipeline ────────────────────────────────────────────────────────────

export async function renderToHTML(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev = false
): Promise<RenderResult> {
  await loadPageModule(route, dev);

  const rootLayout = root ? await loadRootModule(root, dev) : null;

  const loaderResult = await runLoaders(route, ctx, rootLayout);

  if (loaderResult.type === "redirect") {
    throw loaderResult.response;
  }

  const { data, headers } = loaderResult;

  const componentProps = {
    ...data,
    params: ctx.params,
    query: ctx.query,
    path: ctx.path,
  };

  const headData = buildHeadInjection(route.page?.head?.(componentProps));

  const element = buildElement(route, componentProps, rootLayout);
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reactHtml = await streamToString(stream);

  // Dev: self-fetch /_bun_hmr_entry (once, then cached) to get the Bun-processed
  // HTML template with content-hashed chunk paths and HMR WebSocket client.
  // Prod: read .elysion/client/index.html from disk.
  const template = dev ? await getDevTemplate(new URL(ctx.request.url).origin) : getProdTemplate();

  return {
    html: assembleHTML(template, headData, reactHtml, data),
    headers,
  };
}

// ── Public render functions ──────────────────────────────────────────────────

export async function renderToStream(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev = false
): Promise<ReadableStream | Response> {
  try {
    const result = await renderToHTML(route, ctx, root, dev);
    return new Response(result.html).body ?? new ReadableStream();
  } catch (err) {
    return catchRedirect(err);
  }
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout | null,
  dev = false,
  origin = "http://localhost:3000"
): Promise<string> {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = ssgCache.get(resolvedPath);
  if (cached && !dev) {
    return cached;
  }

  const result = await renderForPath(route, params, root, dev, origin);

  if (!dev) {
    ssgCache.set(resolvedPath, result.html);
  }

  return result.html;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev = false
): Promise<Response> {
  try {
    const result = await renderToHTML(route, ctx, root, dev);

    return new Response(result.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        ...result.headers,
      },
    });
  } catch (err) {
    return catchRedirect(err);
  }
}

export async function handleISR(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev = false
): Promise<Response> {
  const revalidate = route.page?._route.revalidate ?? 60;
  const params = ctx.params ?? {};
  const cacheKey = resolvePath(route.pattern, params);

  const cached = isrCache.get(cacheKey);

  if (cached && !dev) {
    const age = Date.now() - cached.generatedAt;
    const isFresh = age < revalidate * 1000;

    if (!isFresh) {
      revalidateInBackground(route, params, cacheKey, revalidate, root, dev, ctx);
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

  try {
    const result = await renderToHTML(route, ctx, root, dev);

    if (!dev) {
      isrCache.set(cacheKey, { html: result.html, generatedAt: Date.now(), revalidate });
    }

    return new Response(result.html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate}`,
        ...result.headers,
      },
    });
  } catch (err) {
    return catchRedirect(err);
  }
}

function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout | null,
  dev: boolean,
  originalCtx: LoaderContext
) {
  const origin = new URL(originalCtx.request.url).origin;

  renderForPath(route, params, root, dev, origin)
    .then((result) => {
      isrCache.set(cacheKey, {
        html: result.html,
        generatedAt: Date.now(),
        revalidate,
      });
    })
    .catch((err: unknown) => {
      console.error("[elysion] ISR background revalidation failed:", err);
    });
}
