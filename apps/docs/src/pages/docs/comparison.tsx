import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/comparison")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Comparison } = await import("@/content/docs/comparison.mdx");
    const doc = DOCS_BY_PATH["/docs/comparison"];
    return {
      content: await renderDocContent(Comparison),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Next.js vs TanStack Start vs Furin — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/comparison"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
