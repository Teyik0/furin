import { defineRoute } from "@teyik0/furin";
import { DocPage } from "@/components/doc-page";
import Routing from "@/content/docs/routing.mdx";
import { DOCS_BY_PATH } from "@/lib/docs";
import { getDocSourceText } from "@/lib/docs-server";
import { route as parentRoute } from "./_route";

export const route = defineRoute()
  .config({ layout: parentRoute, mode: "ssr" })
  .loader(() => {
    const doc = DOCS_BY_PATH["/docs/routing"];
    return { markdownSource: getDocSourceText(doc.sourcePath) };
  })
  .head(() => ({
    meta: [{ title: "File-Based Routing — Furin" }],
  }))
  .page(({ data: { markdownSource } }) => (
    <DocPage
      Content={Routing}
      doc={DOCS_BY_PATH["/docs/routing"]}
      markdownSource={markdownSource}
    />
  ));
