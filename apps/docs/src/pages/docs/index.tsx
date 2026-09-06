import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Introduction from "@/content/docs/introduction.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Documentation — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage Content={Introduction} doc={DOCS_BY_PATH["/docs"]} markdownSource={markdownSource} />
  ));
