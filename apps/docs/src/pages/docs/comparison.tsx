import { DocPage } from "@/components/doc-page";
import Comparison from "@/content/docs/comparison.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Next.js vs TanStack Start vs Furin — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/comparison"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={Comparison}
      doc={DOCS_BY_PATH["/docs/comparison"]}
      markdownSource={markdownSource}
    />
  ),
});
