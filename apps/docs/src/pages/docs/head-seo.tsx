import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(async () => {
    const { default: HeadSeo } = await import("@/content/docs/head-seo.mdx");
    const doc = DOCS_BY_PATH["/docs/head-seo"];
    return {
      content: await renderDocContent(HeadSeo),
      doc,
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Head & SEO — Furin" }],
  }))
  .page(({ content, doc, markdownSource }) => (
    <DocPage doc={doc} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
