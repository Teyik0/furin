import type { ReactNode } from "react";

export interface HeadData {
  title?: string;
  meta?: Array<{
    name?: string;
    property?: string;
    content: string;
    [key: string]: string | undefined;
  }>;
  links?: Record<string, string>[];
  scripts?: Record<string, string>[];
}

interface ShellProps {
  children?: ReactNode;
  data?: Record<string, unknown>;
  headData?: HeadData;
  bootstrapScripts?: string[];
  clientJsPath?: string;
}

export function Shell({ children, data, headData, bootstrapScripts = [], clientJsPath }: ShellProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="UTF-8" />
        <meta content="width=device-width, initial-scale=1.0" name="viewport" />
        {headData?.title && <title>{headData.title}</title>}

        {headData?.meta?.map((meta, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <meta key={i} {...meta} />
        ))}

        {headData?.links?.map((link, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <link key={i} {...link} />
        ))}

        {headData?.scripts?.map((script, i) => (
          //biome-ignore lint/suspicious/noArrayIndexKey: ok
          <script key={i} {...script} />
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

/** Render HeadData into HTML string for <head> */
export function renderHead(headData?: HeadData): string {
  if (!headData) {
    return "";
  }

  const parts: string[] = [];

  if (headData.title) {
    parts.push(`<title>${escapeHtml(headData.title)}</title>`);
  }

  if (headData.meta) {
    for (const meta of headData.meta) {
      const attrs = Object.entries(meta)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}="${escapeHtml(v as string)}"`)
        .join(" ");
      parts.push(`<meta ${attrs} />`);
    }
  }

  if (headData.links) {
    for (const link of headData.links) {
      const attrs = Object.entries(link)
        .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
        .join(" ");
      parts.push(`<link ${attrs} />`);
    }
  }

  if (headData.scripts) {
    for (const script of headData.scripts) {
      const attrs = Object.entries(script)
        .map(([k, v]) => `${k}="${escapeHtml(v)}"`)
        .join(" ");
      parts.push(`<script ${attrs}></script>`);
    }
  }

  return parts.join("\n  ");
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
