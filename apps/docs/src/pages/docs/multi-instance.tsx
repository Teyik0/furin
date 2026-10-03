import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(async () => {
    const { default: MultiInstance } = await import("@/content/docs/multi-instance.mdx");
    const doc = DOCS_BY_PATH["/docs/multi-instance"];
    return {
      content: await renderDocContent(MultiInstance),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Multi-Instance & Micro-Frontends — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/multi-instance"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
