import type { ReactNode } from "react";
import { renderToPipeableStream } from "react-dom/server";
import type { RouteContext } from "./client";
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

async function loadPageModule(route: ResolvedRoute) {
  if (route.page) {
    return route.page;
  }

  const mod = await import(route.pagePath);
  return mod.default;
}

async function loadRootModule(root: RootLayout) {
  return root.route;
}

export type LoaderResult =
  | { type: "data"; data: Record<string, unknown>; headers: Record<string, string> }
  | { type: "redirect"; response: Response };

export async function runLoaders(
  route: ResolvedRoute,
  ctx: LoaderContext,
  rootLayout: any
): Promise<LoaderResult> {
  let data: Record<string, unknown> = {};
  const headers: Record<string, string> = {};

  const loaderCtx = { ...ctx, ...data };

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

export function buildElement(
  route: ResolvedRoute,
  page: any,
  data: Record<string, unknown>,
  rootLayout: any
): ReactNode {
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

interface RenderResult {
  headers: Record<string, string>;
  html: string;
}

async function renderToHTML(
  route: ResolvedRoute,
  ctx: LoaderContext,
  root: RootLayout | null,
  dev: boolean
): Promise<RenderResult> {
  const page = await loadPageModule(route);
  const rootLayout = root ? await loadRootModule(root) : null;

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

  const headData = page.head?.(componentProps);

  const element = buildElement(route, page, componentProps, rootLayout);

  return new Promise((resolve, reject) => {
    const chunks: string[] = [];

    const { pipe } = renderToPipeableStream(element, {
      onShellReady() {},
      onShellError(error) {
        reject(error);
      },
      onError(error) {
        console.error("[elysion] Render error:", error);
      },
    });

    // Bun: pipe returns a Node.js Writable, convert to string
    pipe.on("data", (chunk: Buffer) => {
      chunks.push(chunk.toString());
    });

    pipe.on("end", () => {
      const html = chunks.join("");

      const headInjection = buildHeadInjection(headData, null);
      const bodyInjection = buildBodyInjection(data, CLIENT_JS_PATH, dev);

      const finalHtml = postProcessHTML(html, headInjection, bodyInjection);

      resolve({
        html: finalHtml,
        headers,
      });
    });

    pipe.on("error", reject);
  });
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

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
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
