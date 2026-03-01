import type { RouteContext } from "../client";
import type { buildHeadInjection } from "../shell";

export type LoaderContext = RouteContext<Record<string, string>, Record<string, string>>;

export function resolvePath(pattern: string, params: Record<string, string>): string {
  let path = pattern;
  for (const [key, val] of Object.entries(params)) {
    path = path.replace(key === "*" ? "*" : `:${key}`, val);
  }
  return path;
}

export function createSSGContext(
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
export function assembleHTML(
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
