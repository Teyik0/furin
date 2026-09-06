import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Layouts from "@/content/docs/layouts.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/layouts"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "Nested Layouts — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Layouts}
      doc={DOCS_BY_PATH["/docs/layouts"]}
      markdownSource={markdownSource}
    />
  ));
