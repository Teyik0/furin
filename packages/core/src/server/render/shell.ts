import type { HeadOptions, MetaDescriptor } from "../../client.ts";

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

export function isMetaTag(entry: MetaDescriptor): boolean {
  return !(
    "title" in entry ||
    "charSet" in entry ||
    "script:ld+json" in entry ||
    "tagName" in entry
  );
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

export function renderAttrs(obj: Record<string, string | undefined>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      parts.push(`${k}="${escapeHtml(String(v))}"`);
    }
  }
  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// Head injection helpers
// ---------------------------------------------------------------------------

export function buildMetaParts(meta: MetaDescriptor[]): string[] {
  const parts: string[] = [];
  const title = extractTitle(meta);
  if (title) {
    parts.push(`<title>${escapeHtml(title)}</title>`);
  }
  for (const m of meta) {
    if (isMetaTag(m)) {
      parts.push(`<meta ${renderAttrs(m as Record<string, string>)} />`);
    }
    if ("script:ld+json" in m) {
      parts.push(`<script type="application/ld+json">${safeJson(m["script:ld+json"])}</script>`);
    }
  }
  return parts;
}

export function buildLinkParts(links: NonNullable<HeadOptions["links"]>): string[] {
  return links.map((link) => `<link ${renderAttrs(link)} />`);
}

export function buildScriptParts(scripts: NonNullable<HeadOptions["scripts"]>): string[] {
  return scripts.map((script) => {
    const { children, ...rest } = script;
    const attrs = renderAttrs(rest as Record<string, string | undefined>);
    if (children) {
      return `<script ${attrs}>${children}</script>`;
    }
    return `<script ${attrs}></script>`;
  });
}

export function buildStyleParts(styles: NonNullable<HeadOptions["styles"]>): string[] {
  return styles.map((style) => {
    const typeAttr = style.type ? ` type="${escapeHtml(style.type)}"` : "";
    return `<style${typeAttr}>${style.children}</style>`;
  });
}

/**
 * Builds the string to inject into the <!--ssr-head--> placeholder.
 * Handles title, meta tags, links, inline scripts, and inline styles from
 * the page's `head()` function.  CSS is handled by Bun (imported in user files).
 */
export function buildHeadInjection(headData: HeadOptions | undefined): string {
  const parts: string[] = [];

  if (headData?.meta) {
    parts.push(...buildMetaParts(headData.meta));
  }

  if (headData?.links) {
    parts.push(...buildLinkParts(headData.links));
  }

  if (headData?.scripts) {
    parts.push(...buildScriptParts(headData.scripts));
  }

  if (headData?.styles) {
    parts.push(...buildStyleParts(headData.styles));
  }

  return parts.length > 0 ? `\n  ${parts.join("\n  ")}\n` : "";
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
 *   `__furin_data.ndjson` file instead of the runtime `/_furin/data` endpoint
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
