import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/plugins")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Plugins } = await import("@/content/docs/plugins.mdx");
    const doc = DOCS_BY_PATH["/docs/plugins"];
    return {
      content: await renderDocContent(Plugins),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Plugins — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/plugins"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
