import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { type DocumentAssets, FurinDocumentFallback } from "../../client/document.tsx";
import { normalizeHref, toLogical } from "../../client/router/link-utils.ts";
import type { RouterContextValue } from "../../client/router/types.ts";
import { FurinNotFoundError } from "../../shared/not-found.ts";
import { useLogger } from "../context-logger.ts";
import { currentInstance } from "../instance.ts";
import type { RootLayout } from "../router/types.ts";
import { IS_DEV } from "../runtime-env.ts";
import { streamToString } from "./assemble.ts";
import { withDocumentState } from "./document.tsx";
import { buildNotFoundElement, wrapRootLayout } from "./element.tsx";
import { generateIndexHtml } from "./shell.ts";
import { withSSRRouterContext } from "./ssr.ts";
import {
  documentAssetsFromTemplate,
  getDevDocumentAssets,
  getProductionDocumentAssets,
} from "./template.ts";

/**
 * Renders the root-level not-found component into a complete 404 HTML Response.
 * Used by the Elysia `.onError` catch-all when no route matches the request URL.
 */
export async function renderRootNotFound(
  root: RootLayout,
  request: Request | undefined,
  listenerOrigin?: string
): Promise<Response> {
  const productionAssets = getProductionDocumentAssets();
  let assets: DocumentAssets;
  if (IS_DEV && listenerOrigin) {
    try {
      assets = await getDevDocumentAssets(listenerOrigin);
    } catch {
      assets = documentAssetsFromTemplate(generateIndexHtml());
    }
  } else if (productionAssets === null) {
    assets = documentAssetsFromTemplate(generateIndexHtml());
  } else {
    assets = productionAssets;
  }
  const notFoundError = new FurinNotFoundError(undefined);

  // The request-scope wrap binds the path-resolved instance before this
  // handler runs, so its prefix is the basePath — SSR'd links on the 404
  // page must be physical (prefixed), and currentHref logical, exactly like
  // the regular render pipeline.
  const basePath = currentInstance().prefix;
  const notFoundContext: RouterContextValue = {
    basePath,
    currentHref: request ? normalizeHref(toLogical(new URL(request.url).pathname, basePath)) : "/",
    defaultPreload: "intent",
    defaultPreloadDelay: 50,
    defaultPreloadStaleTime: 30_000,
    invalidatePrefetch: (_path, _type) => {
      /* noop */
    },
    isNavigating: false,
    navigate: (_href, _opts) => Promise.resolve(),
    prefetch: (_href, _opts) => {
      /* noop */
    },
    refresh: (_opts) => Promise.resolve(),
    search: {},
    searchRoutes: [],
  };

  useLogger().set({
    furin: {
      action: "catch_all",
      path: request ? new URL(request.url).pathname : "/",
      render: "not-found",
    },
  });

  const data = { __furinStatus: 404 };
  let reactStream: Awaited<ReturnType<typeof renderToReadableStream>>;
  try {
    reactStream = await renderToReadableStream(
      withDocumentState(
        withSSRRouterContext(
          wrapRootLayout(buildNotFoundElement(root.notFound, notFoundError), {}, root.route),
          notFoundContext
        ),
        assets,
        undefined,
        data
      )
    );
  } catch (renderError) {
    // The user's not-found component itself threw. Fall back to the built-in
    // screen, but surface the failure — silently swallowing it hides a broken
    // 404 page from logs and drains.
    useLogger().set({
      furin: {
        action: "component_render_failed",
        error: renderError instanceof Error ? renderError.message : String(renderError),
        render: "not-found",
      },
    });
    reactStream = await renderToReadableStream(
      withDocumentState(
        createElement(
          FurinDocumentFallback,
          null,
          withSSRRouterContext(buildNotFoundElement(undefined, notFoundError), notFoundContext)
        ),
        assets,
        undefined,
        data
      )
    );
  }
  await reactStream.allReady;
  const html = await streamToString(reactStream);

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
    status: 404,
  });
}
