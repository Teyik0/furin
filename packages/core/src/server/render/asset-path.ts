import type { HeadOptions } from "../../client.ts";
import type { FurinInstance } from "../instance.ts";
import { safeJson } from "./shell.ts";

export function rebaseAssetHref(href: string, instance: FurinInstance): string {
  if (
    instance.prefix === instance.declaredPrefix ||
    !href.startsWith("/") ||
    href.startsWith("//") ||
    href === instance.prefix ||
    href.startsWith(`${instance.prefix}/`)
  ) {
    return href;
  }
  const local = instance.declaredPrefix;
  return local === "" || href === local || href.startsWith(`${local}/`)
    ? instance.prefix + href.slice(local.length)
    : href;
}

export function rebaseDocumentHead(
  head: HeadOptions | undefined,
  instance: FurinInstance
): HeadOptions {
  return {
    ...head,
    links: head?.links?.map((link) => ({ ...link, href: rebaseAssetHref(link.href, instance) })),
    scripts: head?.scripts?.map((script) => ({
      ...script,
      src: script.src === undefined ? undefined : rebaseAssetHref(script.src, instance),
    })),
    meta: [
      ...(head?.meta ?? []).filter((meta) => !("name" in meta && meta.name === "furin-base-path")),
      { name: "furin-base-path", content: instance.prefix },
    ],
  };
}

/** Adapt a build-time document without executing its loaders or changing its data. */
export function rebaseCachedDocument(html: string, instance: FurinInstance): string {
  if (instance.prefix === instance.declaredPrefix) {
    return html;
  }
  const asset = (element: HTMLRewriterTypes.Element) => {
    const attribute = element.tagName === "script" ? "src" : "href";
    const href = element.getAttribute(attribute);
    if (href === null) {
      return;
    }
    const local = instance.declaredPrefix;
    if (
      href.startsWith(`${local}/_client/`) ||
      href.startsWith(`${local}/_furin/`) ||
      href === `${local}/favicon.ico`
    ) {
      element.setAttribute(attribute, rebaseAssetHref(href, instance));
    }
  };
  let headJson = "";
  // biome-ignore lint/correctness/noUndeclaredVariables: HTMLRewriter is a Bun runtime global declared by bun-types.
  return new HTMLRewriter()
    .on('link[rel="stylesheet"],link[rel="modulepreload"],link[rel="icon"],script[src]', {
      element: asset,
    })
    .on("head link[href],head script[src]", {
      element(element) {
        const attribute = element.tagName === "script" ? "src" : "href";
        const href = element.getAttribute(attribute);
        if (href !== null) {
          element.setAttribute(attribute, rebaseAssetHref(href, instance));
        }
      },
    })
    .on('meta[name="furin-base-path"]', {
      element: (element) => {
        element.setAttribute("content", instance.prefix);
      },
    })
    .on('script#__FURIN_HEAD__[type="application/json"]', {
      element(element) {
        headJson = "";
        element.onEndTag((end) => {
          const head = JSON.parse(headJson) as HeadOptions;
          end.before(safeJson(rebaseDocumentHead(head, instance)), { html: true });
        });
      },
      text(text) {
        headJson += text.text;
        text.remove();
      },
    })
    .transform(html);
}
