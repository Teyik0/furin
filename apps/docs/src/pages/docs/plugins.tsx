import { DocPage } from "@/components/doc-page";
import Plugins from "@/content/docs/plugins.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Plugins — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/plugins"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={Plugins}
      doc={DOCS_BY_PATH["/docs/plugins"]}
      markdownSource={markdownSource}
    />
  ),
});
