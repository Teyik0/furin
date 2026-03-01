import type { RouteContext } from "../client";
import type { buildHeadInjection } from "../shell";
import { safeJson } from "../shell";

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

export interface SplitTemplate {
  bodyPost: string;
  bodyPre: string;
  headPre: string;
}

export function splitTemplate(template: string): SplitTemplate {
  const [headPre, afterHead = ""] = template.split("<!--ssr-head-->");
  const [bodyPre, bodyPost = ""] = afterHead.split("<!--ssr-outlet-->");
  return { headPre, bodyPre, bodyPost } as SplitTemplate;
}

export function assembleHTML(
  template: string,
  headData: ReturnType<typeof buildHeadInjection>,
  reactHtml: string,
  data: Record<string, unknown> | undefined
): string {
  const { headPre, bodyPre, bodyPost } = splitTemplate(template);

  const dataScript = data
    ? `<script id="__ELYSION_DATA__" type="application/json">${safeJson(data)}</script>`
    : "";

  return headPre + headData + bodyPre + reactHtml + dataScript + bodyPost;
}
