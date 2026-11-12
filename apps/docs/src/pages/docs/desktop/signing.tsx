import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/desktop/signing")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DesktopContent } = await import("@/content/desktop/signing.mdx");
    const doc = DOCS_BY_PATH["/docs/desktop/signing"];
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
        href: "https://teyik0.github.io/furin/docs/desktop/signing.md",
      },
    ],
    meta: [{ title: "Sign your desktop app — Furin Desktop" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/desktop/signing"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
