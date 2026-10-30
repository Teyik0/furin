import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/desktop/client")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DesktopClientDoc } = await import("@/content/docs/desktop-client.mdx");
    const doc = DOCS_BY_PATH["/docs/desktop/client"];
    return {
      content: await renderDocContent(DesktopClientDoc),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Desktop Client & Server Context — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/desktop/client"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
