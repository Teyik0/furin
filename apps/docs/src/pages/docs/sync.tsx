import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/sync")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Sync } = await import("@/content/docs/sync.mdx");
    const doc = DOCS_BY_PATH["/docs/sync"];
    const content = await renderDocContent(Sync);
    return { content, markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Sync & Invalidations — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/sync"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
