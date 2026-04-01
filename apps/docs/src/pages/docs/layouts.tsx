import { DocPage } from "@/components/doc-page";
import Layouts from "@/content/docs/layouts.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Nested Layouts — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/layouts"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={Layouts}
      doc={DOCS_BY_PATH["/docs/layouts"]}
      markdownSource={markdownSource}
    />
  ),
});
