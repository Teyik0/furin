import { DocPage } from "@/components/doc-page";
import ApiRoutes from "@/content/docs/api-routes.mdx";
import { DOCS_BY_PATH, getDocSourceText } from "@/lib/docs";
import { route } from "./_route";

export default route.page({
  head: () => ({
    meta: [{ title: "API Routes — Furin" }],
  }),
  loader: () => {
    const doc = DOCS_BY_PATH["/docs/api-routes"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  },
  component: ({ markdownSource }) => (
    <DocPage
      Content={ApiRoutes}
      doc={DOCS_BY_PATH["/docs/api-routes"]}
      markdownSource={markdownSource}
    />
  ),
});
