import { DocPage } from "@/components/doc-page";
import Caching from "@/content/docs/caching.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Caching — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/caching"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={Caching}
      doc={DOCS_BY_PATH["/docs/caching"]}
      markdownSource={markdownSource}
    />
  ),
});
