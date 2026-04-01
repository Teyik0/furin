import { DocPage } from "@/components/doc-page";
import Introduction from "@/content/docs/introduction.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Documentation — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage Content={Introduction} doc={DOCS_BY_PATH["/docs"]} markdownSource={markdownSource} />
  ),
});
