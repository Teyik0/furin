import type { StaticOptions } from "@elysiajs/static/types";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { RouteContext, RuntimeRoute } from "./client";
import { getCachedCss } from "./css";
import { getModuleVersion } from "./hmr/watcher";
import type { ResolvedRoute, RootLayout } from "./router";
import { buildBodyInjection, buildHeadInjection, postProcessHTML } from "./shell";

export type LoaderContext = RouteContext<Record<string, string>, Record<string, string>>;

const isrCache = new Map<string, { html: string; generatedAt: number; revalidate: number }>();

const ssgCache = new Map<string, string>();

const CLIENT_JS_PATH = "/_client/_hydrate.js";

function resolvePath(pattern: string, params: Record<string, string>): string {
  return Object.entries(params).reduce((path, [key, val]) => {
    const placeholder = key === "*" ? "*" : `:${key}`;
    return path.replace(placeholder, () => val);
  }, pattern);
}

function createSSGContext(params: Record<string, string>, resolvedPath: string): LoaderContext {
  return {
    params,
    query: {},
    request: new Request(`http://localhost${resolvedPath}`),
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
    try {
      const mod = await import(`${route.pagePath}?v=${getModuleVersion(route.pagePath)}`);
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

export async function loadRootModule(root: RootLayout, _dev: boolean): Promise<RuntimeRoute> {
  if (!_dev) {
    return root.route;
  }

  try {
    const mod = await import(`${root.path}?v=${getModuleVersion(root.path)}`);
    const rootRoute = mod.route ?? mod.default;
    if (rootRoute && rootRoute.__type === "ELYSION_ROUTE") {
      return rootRoute;
    }
    return root.route;
  } catch (error) {
    console.error(`[elysion] Failed to load root layout ${root.path}:`, error);
    return root.route;
  }
}

export function injectSuppressHydration(element: ReactNode): ReactNode {
  if (!element || typeof element !== "object") {
    return element;
  }
  const el = element as { type?: unknown; props?: Record<string, unknown> };
  const type = el.type;
  const props = el.props ?? {};

  if (type === "html" || type === "head" || type === "body") {
    const newProps: Record<string, unknown> = {
      ...props,
      suppressHydrationWarning: true,
    };
    if (props.children) {
      newProps.children = Array.isArray(props.children)
        ? props.children.map(injectSuppressHydration)
        : injectSuppressHydration(props.children as ReactNode);
    }
    return { ...element, props: newProps };
  }

  if (props.children) {
    const newProps = { ...props };
    newProps.children = Array.isArray(props.children)
      ? props.children.map(injectSuppressHydration)
      : injectSuppressHydration(props.children as ReactNode);
    return { ...element, props: newProps };
  }

  return element;
}

export function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute | null,
  _dev: boolean
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

  const headData = route.page?.head?.(componentProps);

  const cssContext = await getCachedCss(process.cwd());

  const element = await buildElement(route, componentProps, rootLayout, dev);

  const stream = await renderToReadableStream(injectSuppressHydration(element));
  await stream.allReady;
  const html = await streamToString(stream);

  if (root) {
    if (!html.includes("<html")) {
      console.warn(
        "[elysion] root.tsx layout is missing an <html> element. Add <html> to your root layout."
      );
    }
    if (!html.includes("<body")) {
      console.warn(
        "[elysion] root.tsx layout is missing a <body> element. Add <body> to your root layout."
      );
    }
  }

  const headInjection = buildHeadInjection(headData, cssContext);
  const bodyInjection = buildBodyInjection(data, CLIENT_JS_PATH, dev);

  return {
    html: postProcessHTML(html, headInjection, bodyInjection),
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
  _config: StaticOptions<string>,
  root: RootLayout | null,
  dev = false
) {
  const resolvedPath = resolvePath(route.pattern, params);

  const cached = ssgCache.get(resolvedPath);
  if (cached && !dev) {
    return cached;
  }

  const ctx = createSSGContext(params, resolvedPath);

  const result = await renderToHTML(route, ctx, root, dev);

  if (!dev) {
    ssgCache.set(resolvedPath, result.html);
  }

  return result.html;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: LoaderContext,
  _config: StaticOptions<string>,
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
  _config: StaticOptions<string>,
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
      revalidateInBackground(route, params, cacheKey, revalidate, root, dev);
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
  dev: boolean
) {
  const resolvedPath = resolvePath(route.pattern, params);

  const ctx = createSSGContext(params, resolvedPath);

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
