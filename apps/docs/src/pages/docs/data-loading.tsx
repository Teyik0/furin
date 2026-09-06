import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import DataLoading from "@/content/docs/data-loading.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/data-loading"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Data Loading — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={DataLoading}
      doc={DOCS_BY_PATH["/docs/data-loading"]}
      markdownSource={markdownSource}
    />
  ));
