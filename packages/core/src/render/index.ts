import { renderToReadableStream } from "react-dom/server";
import type { RootLayout } from "../router";
import { assembleHTML, resolvePath, splitTemplate, streamToString } from "./assemble";
import { isrCache, ssgCache } from "./cache";
import { buildElement } from "./element";
import { runLoaders } from "./loaders";
import { buildHeadInjection, safeJson } from "./shell";
import { getDevTemplate, getProductionTemplate } from "./template";

// ── Re-exports (public API) ──────────────────────────────────────────────────
// biome-ignore lint/performance/noBarrelFile: acnowledged
export { type LoaderContext, streamToString } from "./assemble";
export { buildElement } from "./element";
export { type LoaderResult, runLoaders } from "./loaders";

// ── Types ────────────────────────────────────────────────────────────────────

import type { Context } from "elysia";
import type { ResolvedRoute } from "../router";
import { IS_DEV } from "../runtime-env";
import type { LoaderContext } from "./assemble";
import { generateIndexHtml } from "./shell";

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
  root: RootLayout,
  origin: string
): Promise<RenderResult> {
  const resolvedPath = resolvePath(route.pattern, params);
  return await renderToHTML(
    route,
    {
      params,
      query: {},
      request: new Request(`${origin}${resolvedPath}`),
      headers: {},
      cookie: {},
      redirect: (url, status = 302) => new Response(null, { status, headers: { Location: url } }),
      set: { headers: {} },
      path: resolvedPath,
    } as Context,
    root
  );
}

// ── Core pipeline ────────────────────────────────────────────────────────────

export async function renderToHTML(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<RenderResult> {
  const loaderResult = await runLoaders(route, ctx, root.route);

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

  const element = buildElement(route, componentProps, root.route);
  const stream = await renderToReadableStream(element);
  await stream.allReady;
  const reactHtml = await streamToString(stream);

  // Dev: self-fetch /_bun_hmr_entry (once, then cached) to get the Bun-processed
  // HTML template with content-hashed chunk paths and HMR WebSocket client.
  // Prod: read .elyra/client/index.html from disk.
  const template = IS_DEV
    ? await getDevTemplate(new URL(ctx.request.url).origin)
    : (getProductionTemplate() ?? generateIndexHtml());

  return {
    html: assembleHTML(template, headData, reactHtml, data),
    headers,
  };
}

// ── Public render functions ──────────────────────────────────────────────────

export async function renderToStream(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<ReadableStream | Response> {
  const response = await renderSSR(route, ctx, root);
  if (!response.ok) {
    return response;
  }
  return response.body ?? new ReadableStream();
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout,
  origin = "http://localhost:3000"
): Promise<string> {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = ssgCache.get(resolvedPath);
  if (cached && !IS_DEV) {
    return cached;
  }

  const result = await renderForPath(route, params, root, origin);

  if (!IS_DEV) {
    ssgCache.set(resolvedPath, result.html);
  }

  return result.html;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: Context,
  root: RootLayout
): Promise<Response> {
  try {
    const loaderResult = await runLoaders(route, ctx, root.route);
    if (loaderResult.type === "redirect") {
      return loaderResult.response;
    }

    const { data, headers } = loaderResult;
    const componentProps = { ...data, params: ctx.params, query: ctx.query, path: ctx.path };

    const headData = buildHeadInjection(route.page.head?.(componentProps));
    const template = IS_DEV
      ? await getDevTemplate(new URL(ctx.request.url).origin)
      : (getProductionTemplate() ?? generateIndexHtml());

    // Phase 2: split template around placeholders
    const { headPre, bodyPre, bodyPost } = splitTemplate(template);
    const dataScript = `<script id="__ELYRA_DATA__" type="application/json">${safeJson(data)}</script>`;

    // Phase 3: start React render without awaiting allReady
    const element = buildElement(route, componentProps, root.route);
    const reactStream = await renderToReadableStream(element);

    // Phase 4: pipe head + React stream + tail into a single ReadableStream
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const enc = new TextEncoder();

    (async () => {
      await writer.write(enc.encode(headPre + headData + bodyPre));
      const reader = reactStream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        await writer.write(value);
      }
      await writer.write(enc.encode(dataScript + bodyPost));
      await writer.close();
    })().catch((err) => writer.abort(err));

    return new Response(readable, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        ...headers,
      },
    });
  } catch (err) {
    return catchRedirect(err);
  }
}

export async function handleISR(route: ResolvedRoute, ctx: Context, root: RootLayout) {
  const revalidate = route.page._route.revalidate ?? 60;
  const params = ctx.params ?? {};
  const cacheKey = resolvePath(route.pattern, params);

  const cached = isrCache.get(cacheKey);

  if (cached && !IS_DEV) {
    const age = Date.now() - cached.generatedAt;
    const isFresh = age < revalidate * 1000;

    if (!isFresh) {
      revalidateInBackground(route, params, cacheKey, revalidate, root, ctx);
    }

    ctx.set.headers["content-type"] = "text/html; charset=utf-8";
    ctx.set.headers["cache-control"] = isFresh
      ? `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate}`
      : "public, s-maxage=0, must-revalidate";

    return cached.html;
  }

  try {
    const result = await renderToHTML(route, ctx, root);

    if (!IS_DEV) {
      isrCache.set(cacheKey, { html: result.html, generatedAt: Date.now(), revalidate });
    }

    ctx.set.headers["content-type"] = "text/html; charset=utf-8";
    ctx.set.headers["cache-control"] =
      `public, s-maxage=${revalidate}, stale-while-revalidate=${revalidate}`;
    return result.html;
  } catch (err) {
    return catchRedirect(err);
  }
}

// ── SSG warm-up ──────────────────────────────────────────────────────────────

/** Maximum number of concurrent `prerenderSSG` calls during SSG warm-up. */
const SSG_WARM_CONCURRENCY = 4;

/**
 * Pre-renders all SSG routes that declare `staticParams` and populates the
 * in-memory cache before the first real request arrives.
 * Should be called from the Elysia `onStart` hook (production only).
 *
 * Uses a bounded worker pool (SSG_WARM_CONCURRENCY slots) so large sites
 * with many routes × param sets cannot exhaust memory or CPU during startup.
 * Failures are isolated per (route, params) pair and logged without aborting
 * the rest of the warm-up.
 */
export async function warmSSGCache(
  routes: ResolvedRoute[],
  root: RootLayout,
  origin: string
): Promise<void> {
  const targets = routes.filter((r) => r.mode === "ssg" && r.page.staticParams);

  // Collect all (route, params) render tasks, handling per-route errors early.
  const tasks: Array<() => Promise<void>> = [];
  for (const route of targets) {
    let paramSets: Record<string, string>[];
    try {
      paramSets = (await route.page.staticParams?.()) ?? [];
    } catch (err) {
      console.error(`[elyra] SSG warm-up failed for ${route.pattern}:`, err);
      continue;
    }
    for (const params of paramSets) {
      tasks.push(async () => {
        try {
          await prerenderSSG(route, params, root, origin);
        } catch (err) {
          console.error(`[elyra] SSG prerender failed for ${route.pattern}:`, err);
        }
      });
    }
  }

  if (tasks.length === 0) {
    return;
  }

  // Drain the task queue with a fixed-size worker pool.
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(SSG_WARM_CONCURRENCY, tasks.length) }, async () => {
    while (queue.length > 0) {
      await queue.shift()?.();
    }
  });
  await Promise.all(workers);
}

function revalidateInBackground(
  route: ResolvedRoute,
  params: Record<string, string>,
  cacheKey: string,
  revalidate: number,
  root: RootLayout,
  originalCtx: LoaderContext
) {
  renderForPath(route, params, root, new URL(originalCtx.request.url).origin)
    .then((result) => {
      isrCache.set(cacheKey, {
        html: result.html,
        generatedAt: Date.now(),
        revalidate,
      });
    })
    .catch((err: unknown) => {
      console.error("[elyra] ISR background revalidation failed:", err);
    });
}
