import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/desktop")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DesktopOverview } = await import("@/content/docs/desktop.mdx");
    const doc = DOCS_BY_PATH["/docs/desktop"];
    return {
      content: await renderDocContent(DesktopOverview),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Desktop Overview — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/desktop"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
