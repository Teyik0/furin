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
          const meta = (head.meta ?? []).filter(
            (entry) => !("name" in entry && entry.name === "furin-base-path")
          );
          end.before(
            safeJson({
              ...head,
              meta: [...meta, { name: "furin-base-path", content: instance.prefix }],
            }),
            { html: true }
          );
        });
      },
      text(text) {
        headJson += text.text;
        text.remove();
      },
    })
    .transform(html);
}
