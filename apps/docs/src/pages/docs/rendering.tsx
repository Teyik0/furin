import { DocPage } from "@/components/doc-page";
import Rendering from "@/content/docs/rendering.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Rendering Modes — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/rendering"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={Rendering}
      doc={DOCS_BY_PATH["/docs/rendering"]}
      markdownSource={markdownSource}
    />
  ),
});
