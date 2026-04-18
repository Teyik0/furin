import type { buildHeadInjection } from "./shell";
import { safeJson } from "./shell";

/** Minimal context passed to background / synthetic render helpers — only `request` is needed. */
export interface LoaderContext {
  request: Request;
}

export function resolvePath(pattern: string, params: Record<string, string>): string {
  let path = pattern;
  for (const [key, val] of Object.entries(params ?? {})) {
    path = path.replace(key === "*" ? "*" : `:${key}`, val);
  }
  return path;
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

interface SplitTemplate {
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
    ? `<script id="__FURIN_DATA__" type="application/json">${safeJson(data)}</script>`
    : "";

  let injectedBodyPost = bodyPost;
  if (dataScript) {
    injectedBodyPost = bodyPost.includes("</body>")
      ? bodyPost.replace("</body>", `${dataScript}</body>`)
      : bodyPost + dataScript;
  }

  return headPre + headData + bodyPre + reactHtml + injectedBodyPost;
}
