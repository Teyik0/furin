import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/defer")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: Defer } = await import("@/content/docs/defer.mdx");
    const doc = DOCS_BY_PATH["/docs/defer"];
    return {
      content: await renderDocContent(Defer),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    links: [
      {
        rel: "describedby",
        type: "text/markdown",
        href: "https://teyik0.github.io/furin/docs/llms.txt",
      },
      {
        rel: "alternate",
        type: "text/markdown",
        href: "https://teyik0.github.io/furin/docs/defer.md",
      },
    ],
    meta: [{ title: "Deferred Data — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/defer"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
