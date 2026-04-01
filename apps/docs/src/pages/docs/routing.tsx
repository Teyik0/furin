import { DocPage } from "@/components/doc-page";
import Routing from "@/content/docs/routing.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "File-Based Routing — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/routing"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={Routing}
      doc={DOCS_BY_PATH["/docs/routing"]}
      markdownSource={markdownSource}
    />
  ),
});
