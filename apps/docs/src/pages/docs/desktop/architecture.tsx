import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/desktop/architecture")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DesktopArchitecture } = await import(
      "@/content/docs/desktop-architecture.mdx"
    );
    const doc = DOCS_BY_PATH["/docs/desktop/architecture"];
    return {
      content: await renderDocContent(DesktopArchitecture),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Desktop Architecture — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/desktop/architecture"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
