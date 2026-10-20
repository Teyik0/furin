import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/layouts")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Layouts } = await import("@/content/docs/layouts.mdx");
    const doc = DOCS_BY_PATH["/docs/layouts"];
    return {
      content: await renderDocContent(Layouts),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Nested Layouts — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/layouts"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
