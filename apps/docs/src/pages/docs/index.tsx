import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Introduction } = await import("@/content/docs/introduction.mdx");
    const doc = DOCS_BY_PATH["/docs"];
    return {
      content: await renderDocContent(Introduction),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Documentation — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
