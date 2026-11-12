import type { MetaDescriptor } from "../../client.ts";

export function extractTitle(meta?: MetaDescriptor[]): string | undefined {
  if (!meta) {
    return;
  }
  for (const entry of meta) {
    if ("title" in entry) {
      return (entry as { title: string }).title;
    }
  }
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function generateIndexHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <!--ssr-head-->
  </head>
  <body>
    <div id="root"><!--ssr-outlet--></div>
    <script type="module" src="./_hydrate.tsx"></script>
  </body>
</html>
`;
}

/**
 * Generates the production SSR template (index.html) with hashed asset paths.
 * Called after Bun.build() completes so we can inject the correct entry chunk
 * and CSS paths derived from result.outputs.
 *
 * @param entryChunk - Hashed URL of the client entry script.
 * @param cssChunks - Hashed URLs of the CSS chunks to inject as `<link>`s.
 * @param buildId - Short hash identifying this specific build (or `undefined`
 *   for static exports where stale-deploy detection is not applicable).
 *   Injected as a `<meta name="furin-build-id">` tag so the client can
 *   detect stale deploys.
 * @param faviconHref - Absolute href for the favicon (e.g. "/furin/favicon.ico"),
 *   or `undefined` when no favicon is provided. When set, a `<link rel="icon">`
 *   tag is injected so browsers can locate the favicon even when the site is
 *   served from a sub-path.
 * @param staticMode - `true` for static exports, `false` for SSR/ISR. When
 *   `true`, a `<meta name="furin-mode" content="static">` tag is injected so
 *   the SPA client knows to fetch loader data from the per-route
 *   `__furin_data.ndjson` file instead of runtime `?_furin=data` requests
 *   (which doesn't exist on a static host).
 */
export function generateProdIndexHtml(
  entryChunk: string,
  cssChunks: string[],
  buildId: string | undefined,
  faviconHref: string | undefined,
  staticMode: boolean
): string {
  const cssLinks = cssChunks
    .map((c) => `    <link rel="stylesheet" crossorigin href="${c}">`)
    .join("\n");
  const scriptTag = `<script type="module" crossorigin src="${entryChunk}"></script>`;
  const buildIdMeta = buildId
    ? `    <meta name="furin-build-id" content="${escapeHtml(buildId)}">\n`
    : "";
  const faviconLink = faviconHref
    ? `    <link rel="icon" href="${escapeHtml(faviconHref)}">\n`
    : "";
  const modeMeta = staticMode ? `    <meta name="furin-mode" content="static">\n` : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
${buildIdMeta}${modeMeta}${faviconLink}${cssLinks ? `${cssLinks}\n` : ""}    <!--ssr-head-->
  </head>
  <body>
    <div id="root"><!--ssr-outlet--></div>
    ${scriptTag}
  </body>
</html>
`;
}
