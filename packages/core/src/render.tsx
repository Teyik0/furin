import type { StaticOptions } from "@elysiajs/static/types";
import type { ReactNode } from "react";
import { renderToReadableStream } from "react-dom/server";
import type { RuntimeRoute } from "./client";
import { getCachedCss } from "./css";
import { getModuleVersion } from "./hmr/watcher";
import type { ResolvedRoute, RootLayout } from "./router";
import { buildBodyInjection, buildHeadInjection, postProcessHTML } from "./shell";

const isrCache = new Map<string, { html: string; generatedAt: number; revalidate: number }>();

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

async function loadPageModule(route: ResolvedRoute, dev: boolean) {
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

async function loadRootModule(root: RootLayout, _dev: boolean): Promise<RuntimeRoute> {
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

function injectSuppressHydration(element: ReactNode): ReactNode {
  if (!element || typeof element !== "object") {
    return element;
  }
  const el = element as { type?: unknown; props?: Record<string, unknown> };
  const type = el.type;
  const props = el.props ?? {};

  if (type === "html" || type === "head" || type === "body") {
    const newProps: Record<string, unknown> = { ...props, suppressHydrationWarning: true };
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

async function buildElement(
  route: ResolvedRoute,
  data: Record<string, unknown>,
  rootLayout: RuntimeRoute | null,
  rootPath: string | null,
  dev: boolean
): Promise<ReactNode> {
  const page = route.page;
  if (!page) {
    return <div>Loading...</div>;
  }

  const Component = page.component;
  let element: ReactNode = <Component {...data} />;

  // Wrap with nested layouts (route.tsx), skipping root if it appears in the chain
  for (let i = route.routeChain.length - 1; i >= 0; i--) {
    const filePath = route.routeFilePaths[i];
    // Skip the root layout entry — it will be applied separately below
    if (rootPath && filePath === rootPath) {
      continue;
    }

    let routeEntry = route.routeChain[i];

    // In dev mode, re-import the layout module with a version query so SSR always
    // reflects the latest file content (avoids SSR/client hydration mismatches).
    if (dev && filePath) {
      try {
        const freshMod = await import(`${filePath}?v=${getModuleVersion(filePath)}`);
        const freshRoute = freshMod.route ?? freshMod.default;
        if (freshRoute) {
          routeEntry = freshRoute;
        }
      } catch (err) {
        console.warn(`[elysion] Failed to reload layout ${filePath}:`, err);
        // Fall through to use the startup-cached routeEntry
      }
    }

    if (routeEntry?.layout) {
      const Layout = routeEntry.layout;
      element = <Layout {...data}>{element}</Layout>;
    }
  }

  // Wrap with root layout (root.tsx)
  if (rootLayout?.layout) {
    const RootLayoutComponent = rootLayout.layout;
    element = <RootLayoutComponent {...data}>{element}</RootLayoutComponent>;
  }

  return element;
}

async function runLoaders(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>,
  rootLayout: RuntimeRoute | null,
  rootPath: string | null
): Promise<Record<string, unknown>> {
  let data: Record<string, unknown> = {};

  // Run root loader first
  if (rootLayout?.loader) {
    const result = await rootLayout.loader({ ...data, params, query });
    data = { ...data, ...result };
  }

  // Run nested layout loaders (skip root if it appears in the chain — already ran above)
  for (let i = 0; i < route.routeChain.length; i++) {
    const filePath = route.routeFilePaths[i];
    if (rootPath && filePath === rootPath) {
      continue;
    }
    const ancestor = route.routeChain[i];
    if (ancestor?.loader) {
      const result = await ancestor.loader({ ...data, params, query });
      data = { ...data, ...result };
    }
  }

  // Run page loader
  if (route.page?.loader) {
    const result = await route.page.loader({ ...data, params, query });
    data = { ...data, ...result };
  }

  return data;
}

async function renderAndProcess(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>,
  root: RootLayout | null,
  dev: boolean
): Promise<string> {
  await loadPageModule(route, dev);

  const rootLayout = root ? await loadRootModule(root, dev) : null;
  const rootPath = root?.path ?? null;

  const data = await runLoaders(route, params, query, rootLayout, rootPath);

  // Get head data from page BEFORE building element
  const headData = route.page?.head?.({ ...data, params, query });

  // Get CSS
  const cssContext = await getCachedCss(process.cwd());

  // Build the element tree
  const element = await buildElement(route, { ...data, params, query }, rootLayout, rootPath, dev);

  // Render to HTML — inject suppressHydrationWarning to match client hydration
  const stream = await renderToReadableStream(injectSuppressHydration(element));
  await stream.allReady;
  const html = await streamToString(stream);

  // Warn if root layout is missing required HTML structure
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

  // Post-process HTML to inject scripts (React doesn't need to know about these)
  const headInjection = buildHeadInjection(headData, cssContext);
  const bodyInjection = buildBodyInjection(data, CLIENT_JS_PATH, dev);

  return postProcessHTML(html, headInjection, bodyInjection);
}

export function renderToHTML(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>,
  root: RootLayout | null,
  dev = false
) {
  return renderAndProcess(route, params, query, root, dev);
}

export async function renderToStream(
  route: ResolvedRoute,
  params: Record<string, string>,
  query: Record<string, string>,
  root: RootLayout | null,
  dev = false
) {
  const html = await renderAndProcess(route, params, query, root, dev);
  return new Response(html).body;
}

export async function prerenderSSG(
  route: ResolvedRoute,
  params: Record<string, string>,
  _config: StaticOptions<string>,
  root: RootLayout | null,
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

  const html = await renderToHTML(route, params, {}, root, dev);

  if (!dev) {
    ssgCache.set(resolvedPath, html);
  }

  return html;
}

export async function renderSSR(
  route: ResolvedRoute,
  ctx: { params?: Record<string, string>; query?: Record<string, string> },
  _config: StaticOptions<string>,
  root: RootLayout | null,
  dev = false
): Promise<Response> {
  const html = await renderToHTML(route, ctx.params ?? {}, ctx.query ?? {}, root, dev);

  return new Response(html, {
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
  root: RootLayout | null,
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

  const html = await renderToHTML(route, params, {}, root, dev);

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
  root: RootLayout | null,
  dev: boolean
) {
  renderToHTML(route, params, {}, root, dev)
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
