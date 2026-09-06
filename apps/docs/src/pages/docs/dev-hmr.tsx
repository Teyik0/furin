import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import DevHmr from "@/content/docs/dev-hmr.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/dev-hmr"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Dev Mode HMR — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage Content={DevHmr} doc={DOCS_BY_PATH["/docs/dev-hmr"]} markdownSource={markdownSource} />
  ));
