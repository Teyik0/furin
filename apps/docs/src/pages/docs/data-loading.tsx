import { DocPage } from "@/components/doc-page";
import DataLoading from "@/content/docs/data-loading.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Data Loading — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/data-loading"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={DataLoading}
      doc={DOCS_BY_PATH["/docs/data-loading"]}
      markdownSource={markdownSource}
    />
  ),
});
