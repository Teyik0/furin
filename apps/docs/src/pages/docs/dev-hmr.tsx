import { defineRoute } from "@teyik0/furin";
import { DocContent } from "@/components/doc-content";
import { DocPage } from "@/components/doc-page";
import { renderDocContent } from "@/lib/doc-content";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";

export const route = defineRoute("/docs/dev-hmr")
  .config({ mode: "ssg" })
  .loader(async () => {
    const { default: DevHmr } = await import("@/content/docs/dev-hmr.mdx");
    const doc = DOCS_BY_PATH["/docs/dev-hmr"];
    return {
      content: await renderDocContent(DevHmr),
      markdownSource: getDocSourceText(doc.sourcePath),
    };
  })
  .head(() => ({
    meta: [{ title: "Dev Mode HMR — Furin" }],
  }))
  .page(({ content, markdownSource }) => (
    <DocPage doc={DOCS_BY_PATH["/docs/dev-hmr"]} markdownSource={markdownSource}>
      <DocContent src={content} />
    </DocPage>
  ));
