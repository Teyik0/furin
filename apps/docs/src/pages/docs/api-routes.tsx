import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import ApiRoutes from "@/content/docs/api-routes.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssg" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/api-routes"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "API Routes — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={ApiRoutes}
      doc={DOCS_BY_PATH["/docs/api-routes"]}
      markdownSource={markdownSource}
    />
  ));
