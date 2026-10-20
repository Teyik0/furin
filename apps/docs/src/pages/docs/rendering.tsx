import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/rendering")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Rendering } = await import("@/content/docs/rendering.mdx");
    const doc = DOCS_BY_PATH["/docs/rendering"];
    return {
      content: await renderDocContent(Rendering),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Rendering Modes — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/rendering"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
