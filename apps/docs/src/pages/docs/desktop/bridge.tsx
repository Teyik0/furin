import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/desktop/bridge")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DesktopContent } = await import("@/content/desktop/bridge.mdx");
    const doc = DOCS_BY_PATH["/docs/desktop/bridge"];
    return {
      content: await renderDocContent(DesktopContent),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    links: [
      {
        rel: "describedby",
        type: "text/markdown",
        href: "https://teyik0.github.io/furin/docs/desktop/llms.txt",
      },
      {
        rel: "alternate",
        type: "text/markdown",
        href: "https://teyik0.github.io/furin/docs/desktop/bridge.md",
      },
    ],
    meta: [{ title: "React and the typed desktop bridge — Furin Desktop" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/desktop/bridge"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
