import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { RouteContext, RuntimeRoute } from "./client";
import type { ResolvedRoute, RootLayout } from "./router";
import { buildHeadInjection } from "./shell";

export type LoaderContext = RouteContext<Record<string, string>, Record<string, string>>;

const isrCache = new Map<string, { html: string; generatedAt: number; revalidate: number }>();

const ssgCache = new Map<string, string>();

// ── Dev template ────────────────────────────────────────────────────────────

let _devTemplatePromise: Promise<string> | null = null;

function getDevTemplate(origin: string): Promise<string> {
  _devTemplatePromise ??= fetch(`${origin}/_bun_hmr_entry`)
    .then((r) => {
      if (!r.ok) {
        throw new Error(`/_bun_hmr_entry returned ${r.status}`);
      }
      return r.text();
    })
    .catch((err) => {
      _devTemplatePromise = null;
      throw err;
    });
  return _devTemplatePromise;
}

// ── Template cache ──────────────────────────────────────────────────────────

let _prodTemplate: string | null = null;

/**
 * Reads the production SSR template from disk once and caches it.
 * The template is .elysion/client/index.html produced by buildClient().
 */
function getProdTemplate(): string {
  if (_prodTemplate) {
    return _prodTemplate;
  }
  const templatePath = resolve(process.cwd(), ".elysion", "client", "index.html");
  _prodTemplate = readFileSync(templatePath, "utf8");
  return _prodTemplate;
}

/** Override the prod template (used in tests to avoid disk reads). */
export function _setProdTemplate(template: string): void {
  _prodTemplate = template;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function resolvePath(pattern: string, params: Record<string, string>): string {
  return Object.entries(params).reduce((path, [key, val]) => {
    const placeholder = key === "*" ? "*" : `:${key}`;
    return path.replace(placeholder, () => val);
  }, pattern);
}

function createSSGContext(
  params: Record<string, string>,
  resolvedPath: string,
  origin: string
): LoaderContext {
  return {
    params,
    query: {},
    request: new Request(`${origin}${resolvedPath}`),
    headers: {},
    cookie: {},
    redirect: (url, status = 302) => new Response(null, { status, headers: { Location: url } }),
    set: { headers: {} },
    path: resolvedPath,
  };
}

export async function streamToString(stream: ReadableStream): Promise<string> {
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

export async function loadPageModule(route: ResolvedRoute, dev: boolean) {
  if (!dev && route.page) {
    return route.page;
  }

  if (dev) {
    // In bun --hot mode Bun invalidates its module registry when watched files
    // change, so a plain import() always returns the current version.
    try {
      const mod = await import(route.pagePath);
      route.page = mod.default;
      return route.page;
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

export async function loadRootModule(root: RootLayout, dev: boolean): Promise<RuntimeRoute> {
  if (!dev) {
    return root.route;
  }

  try {
    const mod = await import(root.path);
    const rootRoute = mod.route ?? mod.default;
    if (rootRoute?.__type === "ELYSION_ROUTE") {
      return rootRoute;
    }
    return root.route;
  } catch (error) {
    console.error(`[elysion] Failed to load root layout ${root.path}:`, error);
    return root.route;
  }
}

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute | null
): ReactNode {
  const page = route.page;
  if (!page) {
    return <div>Loading...</div>;
  }

  const Component = page.component;
  let element: ReactNode = <Component {...data} />;

  for (let i = route.routeChain.length - 1; i >= 1; i--) {
    const routeEntry = route.routeChain[i];

    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  if (rootLayout?.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}

export type LoaderResult =
  | { type: "data"; data: Record<string, unknown>; headers: Record<string, string> }
  | { type: "redirect"; response: Response };

export async function runLoaders(
  route: ResolvedRoute,
  ctx: LoaderContext,
  rootLayout: RuntimeRoute | null
): Promise<LoaderResult> {
  let data: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  const loaderCtx = {
    ...ctx,
    ...data,
  };

  try {
    if (rootLayout?.loader) {
      const result = await rootLayout.loader(loaderCtx);
      data = { ...data, ...result };
      Object.assign(headers, ctx.set.headers);
    }

    for (let i = 1; i < route.routeChain.length; i++) {
      const ancestor = route.routeChain[i];
      if (ancestor?.loader) {
        const result = await ancestor.loader({ ...loaderCtx, ...data });
        data = { ...data, ...result };
        Object.assign(headers, ctx.set.headers);
      }
    }

    if (route.page?.loader) {
      const result = await route.page.loader({ ...loaderCtx, ...data });
      data = { ...data, ...result };
      Object.assign(headers, ctx.set.headers);
    }

    return { type: "data", data, headers };
  } catch (err) {
    if (err instanceof Response) {
      return { type: "redirect", response: err };
    }
    throw err;
  }
}

interface RenderResult {
  headers: Record<string, string>;
  html: string;
}

/**
 * Splits the HTML template on the <!--ssr-head--> and <!--ssr-outlet-->
 * placeholders and assembles the final SSR page.
 *
 * Template structure (after Bun processes index.html):
 *   <html>
 *     <head>
 *       ...static meta...
 *       <!--ssr-head-->          ← page-specific title/meta injected here
 *       <script src="/_bun/..."> ← Bun injects hashed chunk + HMR WS client
 *     </head>
 *     <body>
 *       <div id="root">
 *         <!--ssr-outlet-->      ← React SSR HTML injected here
 *       </div>
 *       <script src="/_bun/..."> ← if Bun places scripts in body
 *     </body>
 *   </html>
 */
function assembleHTML(
  template: string,
  headData: ReturnType<typeof buildHeadInjection>,
  reactHtml: string,
  data: Record<string, unknown> | undefined
): string {
  const [headPre, afterHead = ""] = template.split("<!--ssr-head-->");
  const [bodyPre, bodyPost = ""] = afterHead.split("<!--ssr-outlet-->");

  const dataScript = data
    ? `<script id="__ELYSION_DATA__" type="application/json">${JSON.stringify(data)}</script>`
    : "";

  return headPre + headData + bodyPre + reactHtml + dataScript + bodyPost;
}

async function renderAndProcess(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev: boolean
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

  const element = await buildElement(route, componentProps, rootLayout);
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

export function renderToHTML(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev = false
): Promise<RenderResult> {
  return renderAndProcess(route, ctx, root, dev);
}

export async function renderToStream(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev = false
): Promise<ReadableStream | Response> {
  try {
    const result = await renderAndProcess(route, ctx, root, dev);
    return new Response(result.html).body ?? new ReadableStream();
  } catch (err) {
    if (err instanceof Response) {
      return err;
    }
    throw err;
  }
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  root: RootLayout | null,
  dev = false,
  origin = "http://localhost:3000"
) {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = ssgCache.get(resolvedPath);
  if (cached && !dev) {
    return cached;
  }

  const ctx = createSSGContext(params, resolvedPath, origin);

  const result = await renderToHTML(route, ctx, root, dev);

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
    if (err instanceof Response) {
      return err;
    }
    throw err;
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
    if (err instanceof Response) {
      return err;
    }
    throw err;
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
  const resolvedPath = resolvePath(route.pattern, params);
  const origin = new URL(originalCtx.request.url).origin;
  const ctx = createSSGContext(params, resolvedPath, origin);

  renderToHTML(route, ctx, root, dev)
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
