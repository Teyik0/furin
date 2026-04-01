import { DocPage } from "@/components/doc-page";
import DevHmr from "@/content/docs/dev-hmr.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "Dev Mode HMR — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/dev-hmr"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage Content={DevHmr} doc={DOCS_BY_PATH["/docs/dev-hmr"]} markdownSource={markdownSource} />
  ),
});
