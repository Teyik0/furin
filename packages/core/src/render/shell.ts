import type { HeadOptions, MetaDescriptor } from "../client.ts";

export function extractTitle(meta?: MetaDescriptor[]): string | undefined {
  if (!meta) {
    return undefined;
  }
  for (const entry of meta) {
    if ("title" in entry) {
      return (entry as { title: string }).title;
    }
  }
  return undefined;
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
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function renderAttrs(obj: Record<string, string | undefined>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}="${escapeHtml(String(v))}"`)
    .join(" ");
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
 */
export function generateProdIndexHtml(entryChunk: string | null, cssChunks: string[]): string {
  const cssLinks = cssChunks
    .map((c) => `    <link rel="stylesheet" crossorigin href="${c}">`)
    .join("\n");
  const scriptTag = entryChunk
    ? `<script type="module" crossorigin src="${entryChunk}"></script>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
${cssLinks ? `${cssLinks}\n` : ""}    <!--ssr-head-->
  </head>
  <body>
    <div id="root"><!--ssr-outlet--></div>
    ${scriptTag}
  </body>
</html>
`;
}
