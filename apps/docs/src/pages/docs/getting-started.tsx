import { DocPage } from "@/components/doc-page";
import GettingStarted from "@/content/docs/getting-started.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Getting Started — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/getting-started"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={GettingStarted}
      doc={DOCS_BY_PATH["/docs/getting-started"]}
      markdownSource={markdownSource}
    />
  ),
});
