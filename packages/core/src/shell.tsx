import type { ReactNode } from "react";
import type { HeadOptions, MetaDescriptor } from "./client";

interface ShellProps {
  children?: ReactNode;
  data?: Record<string, unknown>;
  headData?: HeadOptions;
  bootstrapScripts?: string[];
  clientJsPath?: string;
}

function extractTitle(meta?: MetaDescriptor[]): string | undefined {
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

function isMetaTag(entry: MetaDescriptor): boolean {
  return !(
    "title" in entry ||
    "charSet" in entry ||
    "script:ld+json" in entry ||
    "tagName" in entry
  );
}

export function Shell({
  children,
  data,
  headData,
  bootstrapScripts = [],
  clientJsPath,
}: ShellProps) {
  const title = extractTitle(headData?.meta);

  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta content="width=device-width, initial-scale=1.0" name="viewport" />
        {title && <title>{title}</title>}

        {headData?.meta?.filter(isMetaTag).map((meta, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <meta key={i} {...meta} />
        ))}

        {headData?.meta
          ?.filter((m): m is { "script:ld+json": object } => "script:ld+json" in m)
          .map((m, i) => (
            <script
              //biome-ignore lint/suspicious/noArrayIndexKey: ok
              dangerouslySetInnerHTML={{ __html: JSON.stringify(m["script:ld+json"]) }}
              key={i}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: ok
              type="application/ld+json"
            />
          ))}

        {headData?.links?.map((link, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <link key={i} {...link} />
        ))}

        {headData?.scripts?.map((script, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <script key={i} {...script} />
        ))}

        {headData?.styles?.map((style, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <style key={i} type={style.type}>
            {style.children}
          </style>
        ))}
      </head>
      <body>
        <div id="root">{children}</div>
        <script
          // biome-ignore lint/security/noDangerouslySetInnerHtml: ok
          dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
          id="__ELYSION_DATA__"
          type="application/json"
        />
        {bootstrapScripts.map((src) => (
          <script key={src} src={src} type="module" />
        ))}
        {clientJsPath && <script defer src={clientJsPath} type="module" />}
      </body>
    </html>
  );
}

function renderAttrs(obj: Record<string, string | undefined>, filterUndefined = false): string {
  return Object.entries(obj)
    .filter(([, v]) => !filterUndefined || v !== undefined)
    .map(([k, v]) => `${k}="${escapeHtml(String(v))}"`)
    .join(" ");
}

function renderMetaTags(meta: MetaDescriptor[]): string[] {
  return meta
    .filter(isMetaTag)
    .map((m) => `<meta ${renderAttrs(m as Record<string, string>, true)} />`);
}

function renderJsonLdTags(meta: MetaDescriptor[]): string[] {
  return meta
    .filter((m): m is { "script:ld+json": object } => "script:ld+json" in m)
    .map(
      (m) => `<script type="application/ld+json">${JSON.stringify(m["script:ld+json"])}</script>`
    );
}

function renderLinkTags(links: HeadOptions["links"]): string[] {
  return (links ?? []).map((link) => `<link ${renderAttrs(link)} />`);
}

function renderScriptTags(scripts: HeadOptions["scripts"]): string[] {
  return (scripts ?? []).map((script) => {
    const { children, ...rest } = script;
    const attrs = renderAttrs(rest as Record<string, string | undefined>, true);
    return children ? `<script ${attrs}>${children}</script>` : `<script ${attrs}></script>`;
  });
}

function renderStyleTags(styles: HeadOptions["styles"]): string[] {
  return (styles ?? []).map((style) => {
    const typeAttr = style.type ? ` type="${escapeHtml(style.type)}"` : "";
    return `<style${typeAttr}>${style.children}</style>`;
  });
}

/** Render HeadOptions into HTML string for <head> */
export function renderHead(headData?: HeadOptions): string {
  if (!headData) {
    return "";
  }

  const parts: string[] = [];

  const title = extractTitle(headData.meta);
  if (title) {
    parts.push(`<title>${escapeHtml(title)}</title>`);
  }

  if (headData.meta) {
    parts.push(...renderMetaTags(headData.meta));
    parts.push(...renderJsonLdTags(headData.meta));
  }
  if (headData.links) {
    parts.push(...renderLinkTags(headData.links));
  }
  if (headData.scripts) {
    parts.push(...renderScriptTags(headData.scripts));
  }
  if (headData.styles) {
    parts.push(...renderStyleTags(headData.styles));
  }

  return parts.join("\n  ");
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
