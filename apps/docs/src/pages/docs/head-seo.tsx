import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import HeadSeo from "@/content/docs/head-seo.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/head-seo"];
    return { doc, markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Head & SEO — Furin" }],
  }))
  .page(({ data: { doc, markdownSource } }) => (
    <DocPage Content={HeadSeo} doc={doc} markdownSource={markdownSource} />
  ));
