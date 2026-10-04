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
    const { default: LinkNavigation } = await import("@/content/docs/link-navigation.mdx");
    const doc = DOCS_BY_PATH["/docs/link-navigation"];
    return {
      content: await renderDocContent(LinkNavigation),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Link & Navigation — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/link-navigation"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
